// 2026-09-06: the month calendar at the top of the dashboard.
//
// The owner: *"At the very top I want to show calender not the form of a
// list of all past and future appointments but as literally a calender where
// the patient/clinician/principal clinician can scroll left and right to see
// all past and upcoming appointments. There is no concept of calender for
// help desk and visitor."*
//
// ## What existed, and why it is not this
//
// Two list views read the same data when this was written:
// `PatientAppointments` (the patient's own, `/account/appointments`) and
// `ClinicianCalendar` (the clinician's, `/account/calendar`). Both were
// tables of rows, both looked **forward only** — the patient's filtered to
// `isLiveOrUpcoming`, the clinician's to a fixed 30-day window — and neither
// could show last month. That last point was the request: a calendar you can
// scroll backwards through is a different thing from a list of what is next.
//
// **2026-09-06: `ClinicianCalendar` and its page are gone**, and this view
// absorbed the four decisions they carried (approve, decline, mark attended,
// no-show). `PatientAppointments` still exists on `/account/appointments`.
//
// ## One component, two endpoints, chosen by role
//
// The two roles' data comes from genuinely different routes, and neither can
// serve the other:
//
//   * a patient reads `GET /patients/me/appointments`, which returns their
//     **whole** history in one response, so every month change is answered
//     from memory with no further request;
//   * a clinician reads `GET /clinicians/me/calendar?from&to`, which
//     *requires* a range (`appointment.ts` returns `RANGE_REQUIRED` without
//     one), so each month is fetched as it is opened.
//
// That asymmetry is why `ranged` below decides whether the visible month is
// a dependency of the fetch at all. Making it one unconditionally would have
// re-downloaded a patient's entire appointment history on every press of the
// back arrow.
//
// Helpdesk and visitor get **nothing rendered** — the owner's "no concept of
// calendar" — and neither endpoint would serve them anyway: `GET
// /clinicians/me/calendar` resolves a helpdesk principal to a column with no
// `read` on another clinician's appointments, and the patient route needs a
// `patientId` they do not have. The page gates them out too
// (`account/index.astro`'s `allowRoles`); this is the second half of that,
// so the component is safe wherever it is mounted.
//
// **A token this bundle cannot read is not a refusal.** It falls through to
// trying the patient route and then the clinician one, letting the server
// answer — the same direction `token-claims.ts` documents at length: hide on
// a positive answer, never on a shrug.
import {
  formatDate,
  formatDateTime,
  formatDayOfMonth,
  formatDateRange,
  formatDayMonthShort,
  formatTimeOfDay,
  formatWeekdayLong,
  formatWeekdayShort,
  t,
} from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Heading, visuallyHiddenClassName } from '@ndn/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import type { ViewerRole } from '../auth/token-claims.js';
import { contentApiUrl } from '../site-config.js';

import {
  dayKey,
  defaultSelectedDay,
  gridRange,
  groupByDay,
  isPastDay,
  isSameDay,
  shiftWindow,
  windowGrid,
  windowStartFor,
  WINDOW_STEP_WEEKS,
} from './calendar-grid.js';
import { JoinCallCell } from './JoinCallCell.js';
import { useNow } from './useNow.js';

/** The fields both endpoints return that this view reads. */
export interface CalendarAppointment {
  readonly patientId: string;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
}

export type CalendarSource = 'patient' | 'clinician';

/**
 * Which endpoint(s) to try for a role, in order.
 *
 * Helpdesk and visitor get an empty list — the owner's "there is no concept
 * of calender for help desk and visitor" — and `undefined` (a token this
 * bundle could not read) gets **both**, so an unreadable claim costs a
 * wasted request rather than a blank dashboard for someone entitled to one.
 */
export function calendarSourcesFor(role: ViewerRole | undefined): readonly CalendarSource[] {
  if (role === 'patient') {
    return ['patient'];
  }
  if (role === 'principal-clinician' || role === 'sub-clinician') {
    return ['clinician'];
  }
  if (role === undefined) {
    return ['patient', 'clinician'];
  }
  return [];
}

/**
 * What a patient is shown on their own calendar.
 *
 * `pending-approval` is excluded because it is not yet an appointment anyone
 * should turn up to — the owner's own rule from 2026-09-02 (*"I only want to
 * see confirmed appointments"*), which `PatientAppointments`,
 * `summariseCalendar` and the notification feed all already keep.
 * `cancelled` is excluded for the same reason read backwards: it never
 * happened, and a calendar of what did happen is what the past half of this
 * view is for.
 *
 * `completed` and `no-show` **are** shown, which is the difference between
 * this and the forward-looking list. They are the patient's own attendance
 * history, and they are the only thing in a past month worth scrolling back
 * to see. A clinician's calendar filters none of this — their view is the
 * working one, and `pending-approval` is precisely the row they need.
 */
export const PATIENT_HIDDEN_STATUSES: readonly string[] = ['pending-approval', 'cancelled'];

export function visibleForPatient(
  items: readonly CalendarAppointment[],
): readonly CalendarAppointment[] {
  return items.filter((item) => !PATIENT_HIDDEN_STATUSES.includes(item.appointment_status));
}

/**
 * The four `POST` transitions this view can reach.
 *
 * `approve`/`decline` are the principal's alone (`authz-matrix.ts`'s
 * `Appointment approval` row); `complete`/`no-show` ride
 * `Appointments: update`, so the treating clinician holds them as well. The
 * server decides which; this list only says what the UI knows how to ask
 * for.
 */
export type AppointmentAction = 'approve' | 'decline' | 'complete' | 'no-show';

type ViewState =
  | { readonly status: 'loading' }
  /** Helpdesk and visitor: not an error, not an empty calendar — no calendar. */
  | { readonly status: 'hidden' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly CalendarAppointment[] };

export interface AppointmentCalendarStrings {
  readonly heading: string;
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly previousWeeksLabel: string;
  readonly nextWeeksLabel: string;
  readonly todayLabel: string;
  readonly gridCaption: string;
  readonly todayMarker: string;
  readonly noAppointmentsOnDay: string;
  readonly emptyWindow: string;
  readonly durationLabel: string;
  readonly minutesSuffix: string;
  readonly statusLabel: string;
  readonly joinCallLabel: string;
  /**
   * 2026-09-06: the four decisions that used to live on `account/calendar`,
   * moved here when that page was deleted. Approve/decline are the
   * principal's; complete/no-show ride `Appointments: update`, so the
   * treating clinician has them too. A patient never sees any of them.
   */
  readonly approveLabel: string;
  readonly declineLabel: string;
  readonly completeLabel: string;
  readonly noShowLabel: string;
  readonly decidingLabel: string;
  readonly decideFailedLabel: string;
  /** Keyed by `appointment_status`; an unknown value falls back to the raw one. */
  readonly statusLabels: Readonly<Record<string, string>>;
}

export interface AppointmentCalendarProps {
  readonly strings: AppointmentCalendarStrings;
  readonly locale: Locale;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to an authorised fetch of the patient's whole history. */
  readonly fetchPatientAppointments?: (accessToken: string) => Promise<Response>;
  /** Injectable for tests; defaults to an authorised, ranged fetch of the clinician's calendar. */
  readonly fetchClinicianCalendar?: (
    from: string,
    to: string,
    accessToken: string,
  ) => Promise<Response>;
  /**
   * 2026-09-06: `POST …/appointments/{apptId}/{approve|decline|complete|no-show}`.
   * Injectable for tests.
   */
  readonly decideAppointment?: (
    accessToken: string,
    entry: CalendarAppointment,
    decision: AppointmentAction,
  ) => Promise<Response>;
  /**
   * Injectable for tests; defaults to the real current time. **A caller
   * passing this must pass a stable reference** — see `useNow.ts` and the
   * unbounded fetch loop an inline `() => new Date()` caused in this
   * directory once already.
   */
  readonly now?: () => Date;
}

/**
 * The one string this component resolves at render time rather than
 * receiving through `strings`.
 *
 * Every other label is looked up by the surrounding Astro page and passed
 * down, which is this directory's convention — but a count-dependent plural
 * cannot be: the count is not known until the appointments are grouped, and
 * a *function* prop cannot cross an Astro island boundary at all (props are
 * serialised into the `<astro-island>` element). `LiveWorkshopList` meets the
 * same wall and solves it by passing a template with a `{title}` placeholder
 * to `String.replace`; that trick cannot express `one`/`other`, so this calls
 * the real ICU formatter instead. `JoinCallCell` already calls `t()` in the
 * browser for its own countdown, so the catalogue is in the client bundle
 * either way.
 */
function dayAppointmentsLabel(count: number, locale: Locale): string {
  return t('accountCalendar.dayAppointments', { count }, locale);
}

const defaultClient = createSessionClient();

/** Module scope, one identity for the lifetime of the module — see `useNow.ts`. */
const systemNow = (): Date => new Date();

function defaultFetchPatientAppointments(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/appointments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultDecideAppointment(
  accessToken: string,
  entry: CalendarAppointment,
  decision: AppointmentAction,
): Promise<Response> {
  // The appointment's own id in a path is its `scheduledAt` — the `{apptId}`
  // segment the API reads, not the composite `<patientId>#<scheduledAt>` a
  // *call* is identified by. The two look similar and are not the same.
  return fetch(
    `${contentApiUrl}/patients/${encodeURIComponent(entry.patientId)}/appointments/${encodeURIComponent(entry.scheduledAt)}/${decision}`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
  );
}

function defaultFetchClinicianCalendar(
  from: string,
  to: string,
  accessToken: string,
): Promise<Response> {
  const url = new URL(`${contentApiUrl}/clinicians/me/calendar`);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
}

export function AppointmentCalendar({
  strings,
  locale,
  client = defaultClient,
  fetchPatientAppointments = defaultFetchPatientAppointments,
  fetchClinicianCalendar = defaultFetchClinicianCalendar,
  decideAppointment = defaultDecideAppointment,
  now = systemNow,
}: AppointmentCalendarProps): ReactNode {
  // Ticks on its own so a join countdown stays honest; `now` (the function)
  // stays stable so this can never become a dependency of the fetch.
  const currentTime = useNow(now);
  // The window's first day, not a month. Opens centred on today — the
  // owner's *"place todays date in the middle so that I see a 2 weeks
  // backward and 2 weeks forward"*.
  const [windowStart, setWindowStart] = useState<Date>(() => windowStartFor(now()));
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [sources, setSources] = useState<readonly CalendarSource[] | undefined>(undefined);
  /** `null` is "the reader has chosen nothing yet", so the default can still apply. */
  const [chosenDay, setChosenDay] = useState<string | null>(null);
  /** Keyed by the row's own composite id, so one row's outcome never speaks for another's. */
  const [deciding, setDeciding] = useState<Record<string, 'busy' | 'failed'>>({});
  /**
   * Approve/decline are the principal's alone, and are hidden rather than
   * offered-then-refused. Starts `true` and narrows only on a *known*
   * non-principal role, so an unreadable token still shows the controls and
   * lets the server answer — `token-claims.ts`'s rule: hide on a positive
   * answer, never on a shrug.
   */
  const [mayDecide, setMayDecide] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void client
      .resolve()
      .then((resolved) => {
        if (cancelled) {
          return;
        }
        if (resolved.status !== 'signed-in') {
          setState({ status: 'forbidden' });
          setSources([]);
          return;
        }
        const role = resolved.session.viewerRole;
        setSources(calendarSourcesFor(role));
        if (role !== undefined) {
          setMayDecide(role === 'principal-clinician');
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error' });
          setSources([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const weeks = useMemo(() => windowGrid(windowStart), [windowStart]);

  // Only a clinician's endpoint takes a range, so only a clinician's calendar
  // makes the visible month part of the fetch. For a patient both of these
  // stay `undefined` across every month change, which keeps `load`'s identity
  // — and therefore the effect below — stable. See this file's header.
  const ranged = sources?.includes('clinician') ?? false;
  const range = ranged ? gridRange(weeks) : undefined;
  const from = range?.from;
  const to = range?.to;

  const load = useCallback(async () => {
    if (!sources) {
      return;
    }
    if (sources.length === 0) {
      setState((current) => (current.status === 'loading' ? { status: 'hidden' } : current));
      return;
    }
    setState({ status: 'loading' });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    // Remembered across attempts so the *last* reason is reported rather than
    // a generic one: a patient-then-clinician fallback that ends in two 403s
    // is a permissions answer, and one that ends in a 500 is not.
    let outcome: 'forbidden' | 'error' = 'forbidden';
    for (const source of sources) {
      try {
        const response =
          source === 'patient'
            ? await fetchPatientAppointments(accessToken)
            : await fetchClinicianCalendar(from ?? '', to ?? '', accessToken);
        if (response.status === 401 || response.status === 403) {
          outcome = 'forbidden';
          continue;
        }
        if (!response.ok) {
          outcome = 'error';
          continue;
        }
        const payload = (await response.json()) as {
          items?: readonly CalendarAppointment[];
        };
        const items = payload.items ?? [];
        setState({
          status: 'ready',
          items: source === 'patient' ? visibleForPatient(items) : items,
        });
        return;
      } catch {
        outcome = 'error';
      }
    }
    setState({ status: outcome });
  }, [client, sources, from, to, fetchPatientAppointments, fetchClinicianCalendar]);

  useEffect(() => {
    void load();
  }, [load]);

  const byDay = useMemo(
    () => groupByDay(state.status === 'ready' ? state.items : []),
    [state],
  );

  // The reader's own choice wins; otherwise today, or the window's first
  // busy day. Derived rather than stored so moving the window re-answers it
  // instead of leaving a stale selection pointing at a square that is no
  // longer drawn.
  const fallbackDay = defaultSelectedDay(weeks, byDay, currentTime);
  const selectedDay =
    chosenDay !== null && weeks.flat().some((day) => dayKey(day) === chosenDay)
      ? chosenDay
      : fallbackDay;

  const decide = async (entry: CalendarAppointment, decision: AppointmentAction) => {
    const rowKey = `${entry.patientId}#${entry.scheduledAt}`;
    setDeciding((current) => ({ ...current, [rowKey]: 'busy' }));
    const accessToken = await client.authorization();
    if (!accessToken) {
      setDeciding((current) => ({ ...current, [rowKey]: 'failed' }));
      return;
    }
    try {
      const response = await decideAppointment(accessToken, entry, decision);
      if (!response.ok) {
        // A 403 (not the principal) and a 409 (already decided) land here
        // together on purpose: both mean "this row is not yours to change
        // now", and both are fixed by reloading and looking again.
        setDeciding((current) => ({ ...current, [rowKey]: 'failed' }));
        return;
      }
      setDeciding((current) => {
        const next = { ...current };
        delete next[rowKey];
        return next;
      });
      // A decision changes the row's status, which changes what this panel
      // and the grid above it should say — so re-read rather than patch.
      await load();
    } catch {
      setDeciding((current) => ({ ...current, [rowKey]: 'failed' }));
    }
  };

  const goToWindow = (next: Date) => {
    setWindowStart(next);
    // A day chosen in the window being left must not survive into the next
    // one — see `selectedDay`.
    setChosenDay(null);
  };

  if (state.status === 'hidden') {
    return null;
  }
  if (state.status === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (state.status === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (state.status === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const windowHasAppointments = weeks
    .flat()
    .some((day) => (byDay.get(dayKey(day))?.length ?? 0) > 0);
  const selectedEntries = selectedDay ? (byDay.get(selectedDay) ?? []) : [];
  const selectedDate = weeks.flat().find((day) => dayKey(day) === selectedDay);
  /** Whose calendar this is — a patient is offered none of the decisions below. */
  const isClinician = sources?.includes('clinician') ?? false;
  const decidingFor = (entry: CalendarAppointment): 'busy' | 'failed' | undefined =>
    deciding[`${entry.patientId}#${entry.scheduledAt}`];
  const firstDayOnGrid = weeks[0]?.[0];
  const lastWeekOnGrid = weeks[weeks.length - 1];
  const lastDayOnGrid = lastWeekOnGrid?.[lastWeekOnGrid.length - 1];

  /**
   * The number in a square — but on the 1st, the month with it.
   *
   * A window of five weeks nearly always spans two months, and a bare "1"
   * between a 31 and a 2 says nothing about which month just began. The
   * range label above the grid names both ends; this is what marks the seam
   * between them, in the one square where it changes.
   */
  const dayLabel = (day: Date): string =>
    day.getDate() === 1 ? formatDayMonthShort(day, locale) : formatDayOfMonth(day, locale);

  return (
    <section className="ndn-cal" aria-labelledby="account-calendar-heading">
      <div className="ndn-cal-bar">
        <Heading level={2} id="account-calendar-heading">
          {strings.heading}
        </Heading>
        <div className="ndn-cal-nav">
          {/* Plain `<button>`s, not `packages/ui`'s `Button`. Two reasons,
              both practical: these are icon-sized controls in a toolbar
              rather than the page's own actions, and `.ndn-button` is what
              `tests/pr-env/keyboard-authenticated.test.ts` probes for its
              "Enter and Space both activate" step — a window-navigation
              control re-rendering the grid under that probe is not the
              button it wants to be testing. Focus styling is restated in
              this component's own stylesheet rather than inherited. */}
          <button
            type="button"
            className="ndn-cal-step"
            onClick={() => goToWindow(shiftWindow(windowStart, -WINDOW_STEP_WEEKS))}
          >
            <span aria-hidden="true">&#8592;</span>
            <span className={visuallyHiddenClassName}>{strings.previousWeeksLabel}</span>
          </button>
          <button
            type="button"
            className="ndn-cal-today"
            onClick={() => goToWindow(windowStartFor(now()))}
          >
            {strings.todayLabel}
          </button>
          <button
            type="button"
            className="ndn-cal-step"
            onClick={() => goToWindow(shiftWindow(windowStart, WINDOW_STEP_WEEKS))}
          >
            <span aria-hidden="true">&#8594;</span>
            <span className={visuallyHiddenClassName}>{strings.nextWeeksLabel}</span>
          </button>
        </div>
      </div>

      {/* The span the window covers, which is no longer a single month —
          `formatDateRange` collapses whatever the two ends share, per
          locale. `aria-live`, because it changes in response to a button
          press elsewhere on the toolbar and the reader who pressed it is not
          looking here. Present from the first render, so it announces
          changes only. */}
      <p className="ndn-cal-month" aria-live="polite">
        {formatDateRange(firstDayOnGrid ?? currentTime, lastDayOnGrid ?? currentTime, locale)}
      </p>

      <div className="ndn-cal-scroll">
        <table className="ndn-cal-grid">
          <caption className={visuallyHiddenClassName}>{strings.gridCaption}</caption>
          <thead>
            <tr>
              {weeks[0]?.map((day) => (
                <th scope="col" key={dayKey(day)}>
                  {/* Abbreviation visible, full name for assistive tech —
                      rather than `<abbr title>`, whose announcement is
                      inconsistent across screen readers. */}
                  <span aria-hidden="true">{formatWeekdayShort(day, locale)}</span>
                  <span className={visuallyHiddenClassName}>
                    {formatWeekdayLong(day, locale)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {weeks.map((week, weekIndex) => (
              // Row position within the window is the row's identity — the
              // whole grid is rebuilt when the window moves, so there is no
              // reordering for an index key to get wrong.
              <tr key={`week-${weekIndex}`}>
                {week.map((day) => {
                  const key = dayKey(day);
                  const entries = byDay.get(key) ?? [];
                  // A rolling window has no "days from the next month" to
                  // grey out — every square is equally part of the view. What
                  // is worth marking instead is the split this view exists to
                  // straddle: what has already happened, and what has not.
                  const past = isPastDay(day, currentTime);
                  const today = isSameDay(day, currentTime);
                  const classes = [
                    'ndn-cal-cell',
                    past ? 'ndn-cal-cell--past' : '',
                    today ? 'ndn-cal-cell--today' : '',
                    key === selectedDay ? 'ndn-cal-cell--selected' : '',
                  ]
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <td key={key} className={classes}>
                      {entries.length === 0 ? (
                        // Not a button: an empty square has nothing to open,
                        // and forty-two tab stops to reach three of them is
                        // a worse keyboard experience than six.
                        <span className="ndn-cal-day">
                          {dayLabel(day)}
                          {today && (
                            <span className={visuallyHiddenClassName}>
                              {' '}
                              {strings.todayMarker}
                            </span>
                          )}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="ndn-cal-day ndn-cal-day--busy"
                          aria-pressed={key === selectedDay}
                          onClick={() => setChosenDay(key)}
                        >
                          <span aria-hidden="true">{dayLabel(day)}</span>
                          {/* The button's accessible name: the full date,
                              how many appointments, and whether it is today.
                              The visible "3" is inside it, so SC 2.5.3
                              (Label in Name) holds. */}
                          <span className={visuallyHiddenClassName}>
                            {formatDayOfMonth(day, locale)} {formatDate(day, locale)}{' '}
                            {dayAppointmentsLabel(entries.length, locale)}
                            {today ? ` ${strings.todayMarker}` : ''}
                          </span>
                          {/* Two renderings of the same appointments, and
                              CSS picks one by width. A seventh of a 390px
                              phone is about 38px of usable cell, where
                              "9:30 AM" truncates to "9:3…" — a time that
                              tells you nothing, which is worse than no time.
                              Below the breakpoint the chips give way to one
                              status-coloured dot each: still "something is
                              booked, and what kind", with the actual times
                              one press away in the panel below.

                              Both are `aria-hidden`: the button's own
                              visually-hidden label already says the date and
                              the count, so announcing either of these would
                              read the same day twice. */}
                          <span className="ndn-cal-chips" aria-hidden="true">
                            {entries.map((entry) => (
                              <span
                                key={`${entry.patientId}#${entry.scheduledAt}`}
                                className={`ndn-cal-chip ndn-cal-chip--${entry.appointment_status}`}
                              >
                                {formatTimeOfDay(entry.scheduledAt, locale)}
                              </span>
                            ))}
                          </span>
                          <span className="ndn-cal-dots" aria-hidden="true">
                            {entries.map((entry) => (
                              <span
                                key={`${entry.patientId}#${entry.scheduledAt}`}
                                className={`ndn-cal-dot ndn-cal-dot--${entry.appointment_status}`}
                              />
                            ))}
                          </span>
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* One short sentence, announced when the selection changes — not the
          panel itself. Choosing a day re-renders a heading, a list of times,
          durations, statuses and possibly a join countdown; marking all of
          that `aria-live` would read the entire day out on every arrow
          press. This says what changed, and the panel below it is there to
          be navigated to. */}
      {/* `aria-live` alone, **not** `role="status"`. Both announce the same
          way, but `role=status` is also how `account-a11y.setup.ts` decides
          the page has finished loading: it waits for
          `getByRole('status')` to reach zero before capturing the signed-in
          storage state. This region is present for the life of the page, so
          carrying that role pinned the count at 1 forever — the setup timed
          out and all 28 authenticated axe scans were skipped. Found on the
          2026-09-06 production run, not by any local suite. */}
      <p className={visuallyHiddenClassName} aria-live="polite">
        {selectedDate
          ? `${formatDate(selectedDate, locale)} ${dayAppointmentsLabel(selectedEntries.length, locale)}`
          : ''}
      </p>

      <div className="ndn-cal-day-panel">
        {!windowHasAppointments && <p>{strings.emptyWindow}</p>}
        {selectedDate && (
          <>
            <Heading level={3} className="ndn-cal-day-heading">
              {formatDate(selectedDate, locale)}
            </Heading>
            {selectedEntries.length === 0 ? (
              <p>{strings.noAppointmentsOnDay}</p>
            ) : (
              <ul className="ndn-cal-day-list">
                {selectedEntries.map((entry) => (
                  <li key={`${entry.patientId}#${entry.scheduledAt}`}>
                    {/* The stored value is UTC ISO-8601; `<time>` carries it
                        machine-readably while the text renders in the site's
                        own locale, in whatever timezone the reader is in.
                        `formatDateTime`, never `toLocaleString()` — see
                        `packages/i18n/src/datetime.ts`. This is the one
                        place on the calendar that names the timezone, which
                        is why the grid above can leave it off. */}
                    <p className="ndn-cal-when">
                      <time dateTime={entry.scheduledAt}>
                        {formatDateTime(entry.scheduledAt, locale)}
                      </time>
                    </p>
                    <p className="ndn-cal-meta">
                      <span>
                        {strings.durationLabel} {entry.durationMinutes} {strings.minutesSuffix}
                      </span>
                      <span>
                        {strings.statusLabel}{' '}
                        {strings.statusLabels[entry.appointment_status] ??
                          entry.appointment_status}
                      </span>
                    </p>
                    {/* Only a confirmed slot can be joined, and only inside
                        its own window — the same three phases `ws-join.ts`
                        enforces, from the same component both existing
                        appointment views already use, so no two screens can
                        disagree about whether a call is open. */}
                    {entry.appointment_status === 'scheduled' && (
                      <p>
                        <JoinCallCell
                          appointment={entry}
                          locale={locale}
                          now={currentTime}
                          joinCallLabel={strings.joinCallLabel}
                        />
                      </p>
                    )}
                    {/* 2026-09-06: the decisions, moved here from
                        `account/calendar` when that page was deleted.

                        `isClinician`, not a role check: a patient's calendar
                        is built from their own history and none of these
                        four routes would accept them. Marking attendance in
                        particular had **no other home in the UI at all** —
                        `PatientRecordPanel` carries approve/decline, nothing
                        carried complete/no-show — and without it
                        `appointment_status` never becomes `completed`, so
                        every "appointments so far" figure reads zero
                        forever. Deleting that page without moving this would
                        have quietly broken those counts. */}
                    {isClinician && (
                      <p className="ndn-cal-actions">
                        {entry.appointment_status === 'pending-approval' && mayDecide && (
                          <>
                            <button
                              type="button"
                              className="ndn-cal-action"
                              disabled={decidingFor(entry) === 'busy'}
                              onClick={() => void decide(entry, 'approve')}
                            >
                              {decidingFor(entry) === 'busy'
                                ? strings.decidingLabel
                                : strings.approveLabel}
                            </button>
                            <button
                              type="button"
                              className="ndn-cal-action"
                              disabled={decidingFor(entry) === 'busy'}
                              onClick={() => void decide(entry, 'decline')}
                            >
                              {strings.declineLabel}
                            </button>
                          </>
                        )}
                        {/* Offered for every confirmed appointment rather
                            than only past ones: a clinician marking a session
                            the moment it ends is the realistic flow, and
                            "past" would need a clock this panel would then
                            disagree with the server about. The server refuses
                            anything that is not still `scheduled`. */}
                        {entry.appointment_status === 'scheduled' && (
                          <>
                            <button
                              type="button"
                              className="ndn-cal-action"
                              disabled={decidingFor(entry) === 'busy'}
                              onClick={() => void decide(entry, 'complete')}
                            >
                              {decidingFor(entry) === 'busy'
                                ? strings.decidingLabel
                                : strings.completeLabel}
                            </button>
                            <button
                              type="button"
                              className="ndn-cal-action"
                              disabled={decidingFor(entry) === 'busy'}
                              onClick={() => void decide(entry, 'no-show')}
                            >
                              {strings.noShowLabel}
                            </button>
                          </>
                        )}
                        {decidingFor(entry) === 'failed' && (
                          <span role="alert">{strings.decideFailedLabel}</span>
                        )}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}
