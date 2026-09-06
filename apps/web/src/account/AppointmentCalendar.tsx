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
// Two list views already read the same data: `PatientAppointments` (the
// patient's own, `/account/appointments`) and `ClinicianCalendar` (the
// clinician's, `/account/calendar`). Both are tables of rows, both look
// **forward only** — the patient's filters to `isLiveOrUpcoming`, the
// clinician's to a fixed 30-day window — and neither can show last month.
// That last point is the request: a calendar you can scroll backwards
// through is a different thing from a list of what is next, and this is the
// former. Neither existing page is replaced here; both keep their own job.
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
  formatMonthYear,
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
  isInMonth,
  isSameDay,
  monthGrid,
  monthOf,
  shiftMonth,
} from './calendar-grid.js';
import type { CalendarMonth } from './calendar-grid.js';
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
  readonly previousMonthLabel: string;
  readonly nextMonthLabel: string;
  readonly todayLabel: string;
  readonly gridCaption: string;
  readonly todayMarker: string;
  readonly noAppointmentsOnDay: string;
  readonly emptyMonth: string;
  readonly durationLabel: string;
  readonly minutesSuffix: string;
  readonly statusLabel: string;
  readonly joinCallLabel: string;
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
  now = systemNow,
}: AppointmentCalendarProps): ReactNode {
  // Ticks on its own so a join countdown stays honest; `now` (the function)
  // stays stable so this can never become a dependency of the fetch.
  const currentTime = useNow(now);
  const [month, setMonth] = useState<CalendarMonth>(() => monthOf(now()));
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [sources, setSources] = useState<readonly CalendarSource[] | undefined>(undefined);
  /** `null` is "the reader has chosen nothing yet", so the default can still apply. */
  const [chosenDay, setChosenDay] = useState<string | null>(null);

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
        setSources(calendarSourcesFor(resolved.session.viewerRole));
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

  const weeks = useMemo(() => monthGrid(month), [month]);

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

  // The reader's own choice wins; otherwise today, or the month's first busy
  // day. Derived rather than stored so moving to another month re-answers it
  // instead of leaving a stale selection pointing at a square that is no
  // longer drawn.
  const fallbackDay = defaultSelectedDay(weeks, month, byDay, currentTime);
  const selectedDay =
    chosenDay !== null && weeks.flat().some((day) => dayKey(day) === chosenDay)
      ? chosenDay
      : fallbackDay;

  const goToMonth = (next: CalendarMonth) => {
    setMonth(next);
    // A day chosen in the month being left must not survive into the next
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

  const monthHasAppointments = weeks
    .flat()
    .some((day) => isInMonth(day, month) && (byDay.get(dayKey(day))?.length ?? 0) > 0);
  const selectedEntries = selectedDay ? (byDay.get(selectedDay) ?? []) : [];
  const selectedDate = weeks.flat().find((day) => dayKey(day) === selectedDay);

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
              "Enter and Space both activate" step — a month-navigation
              control re-rendering the grid under that probe is not the
              button it wants to be testing. Focus styling is restated in
              this component's own stylesheet rather than inherited. */}
          <button
            type="button"
            className="ndn-cal-step"
            onClick={() => goToMonth(shiftMonth(month, -1))}
          >
            <span aria-hidden="true">&#8592;</span>
            <span className={visuallyHiddenClassName}>{strings.previousMonthLabel}</span>
          </button>
          <button
            type="button"
            className="ndn-cal-today"
            onClick={() => goToMonth(monthOf(now()))}
          >
            {strings.todayLabel}
          </button>
          <button
            type="button"
            className="ndn-cal-step"
            onClick={() => goToMonth(shiftMonth(month, 1))}
          >
            <span aria-hidden="true">&#8594;</span>
            <span className={visuallyHiddenClassName}>{strings.nextMonthLabel}</span>
          </button>
        </div>
      </div>

      {/* `aria-live`, because the month name changes in response to a button
          press somewhere else on the toolbar — the reader who pressed it is
          not looking here. Present from the first render, so it announces
          changes only. */}
      <p className="ndn-cal-month" aria-live="polite">
        {formatMonthYear(new Date(month.year, month.month, 1), locale)}
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
              // Row position within the month is the row's identity — the
              // whole grid is rebuilt when the month changes, so there is no
              // reordering for an index key to get wrong.
              <tr key={`week-${weekIndex}`}>
                {week.map((day) => {
                  const key = dayKey(day);
                  const entries = byDay.get(key) ?? [];
                  const outside = !isInMonth(day, month);
                  const today = isSameDay(day, currentTime);
                  const classes = [
                    'ndn-cal-cell',
                    outside ? 'ndn-cal-cell--outside' : '',
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
                          {formatDayOfMonth(day, locale)}
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
                          <span aria-hidden="true">{formatDayOfMonth(day, locale)}</span>
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
      <p className={visuallyHiddenClassName} role="status" aria-live="polite">
        {selectedDate
          ? `${formatDate(selectedDate, locale)} ${dayAppointmentsLabel(selectedEntries.length, locale)}`
          : ''}
      </p>

      <div className="ndn-cal-day-panel">
        {!monthHasAppointments && <p>{strings.emptyMonth}</p>}
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
