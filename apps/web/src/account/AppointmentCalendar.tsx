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
// **A visitor gets nothing rendered** — the surviving half of the owner's
// "there is no concept of calender for help desk and visitor" — and neither
// endpoint would serve one anyway: the patient route needs a `patientId` they
// do not have, and the clinician route would answer with an empty range.
//
// **Helpdesk changed on 2026-09-06**, at the owner's word: *"for help desk I
// want to show on the landing dashboard both ready only calender and patient
// dashboard — the two stuff the principal clinician is seeing but in read only
// mode."* They read the clinician route and the server answers with the
// *practice's* calendar rather than their own empty one — `appointment.ts`
// carries the reasoning, and `authz-matrix.ts`'s Helpdesk column already
// granted the unnarrowed `R` that makes it legitimate. What "read only"
// means here is `mayActOnAppointments`: the four decisions below the day
// panel are not rendered for them at all.
//
// The page gates the roles too (`account/index.astro`'s `allowRoles`); this
// is the second half of that, so the component is safe wherever it is
// mounted.
//
// ## 2026-09-06: the call is reachable from the calendar, not only from a day
//
// *"in patient and clinician landing dashboard there is a calender that shows
// the next coming appointment. when the appointment comes I want to have a
// 'join call' button on the calender that both can click to join the call."*
//
// A join control has been in the day panel since this view was built, and
// that is not where the request is unmet: it is drawn for the **selected**
// day, below a five-week grid, so at the instant a call opens the link is on
// a part of the page nobody is looking at, and nothing says it has appeared.
// A reader who has scrolled to last month has no join control at all.
//
// So `liveAppointment` asks a question of the whole loaded set rather than of
// one square — *is a call open right now* — and its answer is a banner above
// the grid with the link in it, plus a `--live` mark on the appointment's own
// chip and dot. It is derived from the ticking clock, so it arrives on its own
// within `CLOCK_TICK_MS` of the slot opening and leaves when the slot ends.
// One component, so the patient and the clinician get the identical thing and
// cannot disagree about whether the call is open.
//
// The same change gates the join control on `mayJoinCalls`. A helpdesk reads
// the practice's calendar and holds no `join-call` in `authz-matrix.ts`, so
// until now they were shown countdowns and links into calls the server would
// refuse — the failure mode `JoinCallCell`'s header is written against.
//
// **A token this bundle cannot read is not a refusal.** It falls through to
// trying the patient route and then the clinician one, letting the server
// answer — the same direction `token-claims.ts` documents at length: hide on
// a positive answer, never on a shrug.
//
// ## 2026-09-08: moving the window no longer empties it
//
// The owner: *"when I change month in my calender the calender disappears
// for a second before coming back again (keep the old month as is while the
// nice month is being fetched)."*
//
// It did, and only for a clinician: their endpoint takes a range, so every
// press of an arrow refetched — and `load` opened by setting the whole view
// back to `loading`, which is the branch that returns a single line of text
// in place of the grid. The toolbar the reader had just pressed vanished
// along with it, so the second press had nothing to aim at.
//
// The fix is the ordinary one for a view that is re-reading data it already
// has: keep showing what is on screen and mark it stale, rather than
// throwing it away and starting from nothing. `load` now only falls back to
// `loading` when there is nothing to fall back *to* — the first fetch of the
// session — and every later one leaves the last good `items` in place while
// `refreshing` drives `aria-busy` and a small ring beside the range label.
// The grid under it is the **outgoing** month for those few hundred
// milliseconds, which is exactly what was asked for.
//
// A refresh that fails is treated the same way: a clinician who has scrolled
// to a month the API cannot answer keeps the month they were reading and
// gets one line saying the newer one did not load. Blanking a calendar
// somebody is using in order to report a transient 500 loses more than it
// tells them. The **first** load still fails to `error` as before — there is
// nothing behind it to keep.
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
import { Heading, Link, Spinner, visuallyHiddenClassName } from '@ndn/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { joinPhase } from './join-window.js';
import { callHref, JoinCallCell } from './JoinCallCell.js';
import { PanelPlaceholder } from './PanelPlaceholder.js';
import { useNow } from './useNow.js';

/** The fields both endpoints return that this view reads. */
export interface CalendarAppointment {
  readonly patientId: string;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
  /**
   * 2026-09-06: who the appointment is *with*, joined onto the row by the
   * API (`services/api/src/appointment.ts`) rather than stored on it.
   *
   * Both are optional, and their absence is meaningful rather than a
   * loading state: the server omits a name it will not disclose to this
   * caller (the patient name is gated on the `Patient profile` row, not on
   * the `Appointments` read that returned the row) and omits one that is
   * genuinely not recorded. Either way there is nothing to show, so the
   * line is dropped instead of rendering a label with a blank after it.
   */
  readonly patientName?: string;
  readonly clinicianName?: string;
}

export type CalendarSource = 'patient' | 'clinician';

/**
 * Which endpoint(s) to try for a role, in order.
 *
 * **2026-09-06: helpdesk joins the clinician route.** The owner: *"for help
 * desk I want to show on the landing dashboard both ready only calender and
 * patient dashboard — the two stuff the principal clinician is seeing but in
 * read only mode."* This reverses the "no concept of calender for help desk
 * and visitor" half of 2026-09-06's first pass **for helpdesk only** —
 * a visitor still gets nothing, which is the half that was never questioned.
 *
 * The server answers a helpdesk with the *practice's* calendar rather than
 * their own empty one (`appointment.ts`'s own note on why "me" means the desk
 * for that role), so the same request key serves both.
 *
 * `undefined` (a token this bundle could not read) gets **both**, so an
 * unreadable claim costs a wasted request rather than a blank dashboard for
 * someone entitled to one.
 */
export function calendarSourcesFor(role: ViewerRole | undefined): readonly CalendarSource[] {
  if (role === 'patient') {
    return ['patient'];
  }
  if (role === 'principal-clinician' || role === 'sub-clinician' || role === 'helpdesk') {
    return ['clinician'];
  }
  if (role === undefined) {
    return ['patient', 'clinician'];
  }
  return [];
}

/**
 * Whether this role may *change* an appointment from the calendar — the four
 * decisions below the day panel.
 *
 * Separate from "does this role have a calendar at all", because since
 * 2026-09-06 those two answers differ: a helpdesk reads the practice's
 * calendar and decides nothing on it, which is the whole of what "in read
 * only mode" asked for. `undefined` is `true` on this file's standing rule —
 * hide on a positive answer, never on a shrug — and the server refuses
 * anything the caller may not do.
 */
export function mayActOnAppointments(role: ViewerRole | undefined): boolean {
  return role === undefined || role === 'principal-clinician' || role === 'sub-clinician';
}

/**
 * Whether this role is ever a *party* to a call, and so should be offered a
 * way into one.
 *
 * A third answer alongside "has a calendar" and "may change what is on it",
 * because since 2026-09-06 all three differ. `authz-matrix.ts`'s
 * `Appointments` row grants `join-call` to the patient, the assigned
 * sub-clinician and the principal, and **withholds it from Helpdesk**, who
 * hold plain `R` — so a helpdesk reading the practice's calendar would be
 * shown a link `ws-join.ts` is certain to refuse with
 * `not-your-appointment`. `JoinCallCell`'s own header states the rule this
 * is applying: a link that looks live and is refused on arrival is worse
 * than no link, because by then the person has already believed in it.
 *
 * `undefined` (a token this bundle could not read) is `true`, on this
 * file's standing rule — hide on a positive answer, never on a shrug — and
 * the server is the boundary either way.
 */
export function mayJoinCalls(role: ViewerRole | undefined): boolean {
  return role !== 'helpdesk' && role !== 'visitor';
}

/**
 * The appointment happening **right now**, or nothing.
 *
 * 2026-09-06. The owner: *"in patient and clinician landing dashboard there
 * is a calender that shows the next coming appointment. when the
 * appointment comes I want to have a 'join call' button on the calender
 * that both can click to join the call."*
 *
 * The join control itself already existed — `JoinCallCell` has rendered one
 * per row in the day panel since this view was built. What it lacked was
 * *reach*: it is drawn only for the day the reader currently has selected,
 * below a five-week grid, so at the moment a call opens the link exists on
 * a part of the page nobody is looking at and nothing says it has appeared.
 * This is the question the banner above the grid asks instead — one whose
 * answer changes on its own as the clock ticks past `scheduledAt`.
 *
 * Only `scheduled` counts: `ws-join.ts` denies `pending-approval` with
 * `not-confirmed` and every other status as `cancelled`, so an appointment
 * in any of them has no call to join however live its slot looks.
 *
 * The **earliest** open one when several overlap — a real possibility on a
 * clinician's calendar, and the one that started first is the one they are
 * late for. `find` would return whichever the API happened to list first.
 */
export function liveAppointment(
  items: readonly CalendarAppointment[],
  now: Date,
): CalendarAppointment | undefined {
  let earliest: CalendarAppointment | undefined;
  for (const item of items) {
    if (item.appointment_status !== 'scheduled') {
      continue;
    }
    const scheduledAt = new Date(item.scheduledAt);
    // A malformed instant is not live. `joinPhase` alone could not say so —
    // every `NaN` comparison is false, so it would fall through to `'open'`
    // and offer a link for an appointment that cannot be addressed. The
    // same deny-by-default reading `isLiveOrUpcoming` takes.
    if (Number.isNaN(scheduledAt.getTime())) {
      continue;
    }
    if (joinPhase(scheduledAt, item.durationMinutes, now) !== 'open') {
      continue;
    }
    if (!earliest || item.scheduledAt < earliest.scheduledAt) {
      earliest = item;
    }
  }
  return earliest;
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
  /**
   * 2026-09-08: shown beside a small ring while a *later* fetch is in
   * flight — a clinician moving the window, or any role re-reading after a
   * decision. Distinct from `loadingLabel`, which stands in place of the
   * whole calendar and is only ever seen once per session: this one sits
   * next to a calendar that is still on screen, so it says the view is
   * being updated rather than that it is being loaded.
   */
  readonly refreshingLabel: string;
  /** The same fetch, failed, with a good month still drawn underneath — so it reports the miss rather than replacing the calendar with `errorLabel`. */
  readonly refreshFailedLabel: string;
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
  /** 2026-09-06: *"it should also show the name of the patient and the name of the clinician."* */
  readonly patientLabel: string;
  readonly clinicianLabel: string;
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

/**
 * The second string resolved here rather than passed in, and for a harder
 * reason than the plural above: it *cannot* be passed in.
 *
 * The sentence names the time the call started, so its catalogue entry
 * carries a `{time}` placeholder — and `t()` formats through
 * `IntlMessageFormat`, which **throws** when a template's argument is not
 * supplied. The Astro page resolves every other label with
 * `t(key, undefined, locale)` at build time; doing that to this one would
 * fail the build rather than hand down a template to fill in later. So the
 * value and the sentence have to meet in the same call, and the only place
 * that knows the value is here.
 *
 * A whole sentence, not a label with a time appended: it is inserted into a
 * live region and read out on its own, with nothing before it for context.
 */
function liveNowLabel(scheduledAt: string, locale: Locale): string {
  return t('accountCalendar.liveNow', { time: formatTimeOfDay(scheduledAt, locale) }, locale);
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
  // backward and 2 weeks forward"*, where "the middle" is the middle **row**:
  // today's week sits on `CENTER_ROW` and the Mon…Sun columns stay put. The
  // owner's own resolution of the second pass's dilemma — *"keep the current
  // date in the middle row and everything works/looks like a wall calender"* —
  // and `calendar-grid.ts`'s header carries the full reasoning.
  const [windowStart, setWindowStart] = useState<Date>(() => windowStartFor(now()));
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  /**
   * 2026-09-08: a fetch is in flight *over a calendar that is already
   * drawn* — the state the owner asked for when they said the calendar
   * should not disappear between months. Separate from `state`, because it
   * is not a fourth thing the view can be: `state` stays `ready` with the
   * outgoing month's rows in it for the whole of this, and only `aria-busy`
   * and a small ring beside the range say a newer answer is coming.
   */
  const [refreshing, setRefreshing] = useState(false);
  /** That fetch, failed. Reported in a line under the toolbar rather than by replacing the month the reader still has open — see this file's header. */
  const [refreshFailed, setRefreshFailed] = useState(false);
  /**
   * Whether a good answer has ever been drawn.
   *
   * A ref rather than derived from `state` inside `load`, and that is not a
   * style choice: `load` is a `useCallback` whose identity is the dependency
   * of the effect that calls it, so reading `state` there would rebuild it
   * on every state change and refetch in a loop. This directory has been
   * bitten by exactly that shape once already — see `useNow.ts` on the
   * inline `() => new Date()` that caused an unbounded fetch loop.
   */
  const hasLoadedOnce = useRef(false);
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
  /**
   * Whether *any* of the four decisions is offered. Distinct from
   * `mayDecide`, which is approve/decline alone: since 2026-09-06 a helpdesk
   * reads this calendar and may change nothing on it, so complete/no-show
   * need their own answer rather than riding "is this a clinician's
   * calendar". Same starting value and same rule — see
   * `mayActOnAppointments`.
   */
  const [mayAct, setMayAct] = useState(true);
  /**
   * Whether this reader is ever a party to a call. A third answer again,
   * and not derivable from the other two: a helpdesk has a calendar
   * (`calendarSourcesFor`) and may change nothing on it (`mayAct`), and is
   * *also* not on the call — `authz-matrix.ts` withholds `join-call` from
   * them. See `mayJoinCalls`; same starting value and same rule.
   */
  const [mayJoin, setMayJoin] = useState(true);

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
        setMayAct(mayActOnAppointments(role));
        setMayJoin(mayJoinCalls(role));
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
    // The whole of the "keep the old month while the new one is fetched"
    // change is this line and the three that answer it below: fall back to
    // the loading placeholder only when there is nothing already drawn to
    // keep. Every later fetch — a window move, a re-read after a decision —
    // leaves `state` exactly as it is and raises `refreshing` instead.
    if (!hasLoadedOnce.current) {
      setState({ status: 'loading' });
    }
    setRefreshing(true);
    setRefreshFailed(false);
    const accessToken = await client.authorization();
    if (!accessToken) {
      // Not a stale-data case: no token means no session, and a calendar
      // of somebody's appointments is not something to leave on screen
      // once that is true.
      hasLoadedOnce.current = false;
      setRefreshing(false);
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
        hasLoadedOnce.current = true;
        setRefreshing(false);
        setState({
          status: 'ready',
          items: source === 'patient' ? visibleForPatient(items) : items,
        });
        return;
      } catch {
        outcome = 'error';
      }
    }
    setRefreshing(false);
    if (hasLoadedOnce.current) {
      // A month already on screen is worth more than the reason the next
      // one did not arrive. The reader keeps what they were reading and is
      // told the update failed; pressing the arrow again retries.
      setRefreshFailed(true);
      return;
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
    // Only ever the *first* fetch of the session now — see `load`. The
    // skeleton is a five-by-seven grid because that is what lands on top of
    // it, so the page below does not jump when the real one arrives.
    return <PanelPlaceholder label={strings.loadingLabel} shape="calendar" />;
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
  /**
   * Re-derived on every tick of `currentTime`, so this appears the moment
   * the slot opens and goes again when it ends — no reload, and no reliance
   * on the reader happening to have the right day selected.
   *
   * Read from `state.items`, not from the selected day's bucket: a call that
   * is open right now is worth surfacing whatever square the reader has
   * wandered off to. A role that is not on the call gets nothing at all
   * rather than a banner with no way out of it.
   */
  const live = mayJoin ? liveAppointment(state.items, currentTime) : undefined;
  const liveKey = live ? `${live.patientId}#${live.scheduledAt}` : undefined;
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
            {/* Up, not left. The window moves through weeks the way the grid
                stacks them — earlier weeks are above, later ones below — so a
                sideways arrow would name an axis this calendar does not use.
                The accessible label says "earlier", which is the meaning; the
                glyph says which way it moves. */}
            <span aria-hidden="true">&#8593;</span>
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
            <span aria-hidden="true">&#8595;</span>
            <span className={visuallyHiddenClassName}>{strings.nextWeeksLabel}</span>
          </button>
        </div>
      </div>

      {/* ## The join button, when there is a call to join
          2026-09-06: *"when the appointment comes I want to have a 'join
          call' button on the calender that both can click to join the
          call."*

          Above the grid, not inside a square and not in the day panel: at
          the moment a call opens, the one thing worth putting in front of
          both parties is the way into it, and neither of those places is
          where a reader is looking. The panel below still carries its own
          per-row control — this does not replace it, it makes it reachable
          without first finding the right day.

          `Link`, not a `<button>`: this navigates to `call.astro`, so it
          must open in a new tab on a middle-click and show its target on
          hover like every other link on the site. It is styled as a
          call-to-action; that is a matter for the stylesheet, not for the
          element.

          **The wrapper is always rendered and the banner is not.** An
          `aria-live` region has to already exist for an insertion into it
          to be announced — a region that appears with its content is
          unreliable across screen readers — and this is the one thing on
          the calendar whose whole purpose is to arrive unprompted, thirty
          seconds after the clock crossed `scheduledAt`. `aria-live` alone
          and never `role="status"`, for the reason the region further down
          spells out: `account-a11y.setup.ts` waits for the status count to
          reach zero, and a permanent one pinned it at 1 and cost 28
          authenticated axe scans. */}
      <div className="ndn-cal-live-region" aria-live="polite">
        {live && (
          <p className="ndn-cal-live">
            <span>
              {liveNowLabel(live.scheduledAt, locale)}
              {/* Who it is with — the *other* party, which is a different
                  field depending on whose calendar this is. Worth the line
                  for a clinician working back-to-back slots, who needs to
                  know which patient is waiting before pressing anything.
                  Rendered only when the API sent a name; see
                  `CalendarAppointment` on why an absent one is an answer
                  rather than a gap. */}
              {isClinician
                ? live.patientName && ` ${strings.patientLabel} ${live.patientName}`
                : live.clinicianName && ` ${strings.clinicianLabel} ${live.clinicianName}`}
            </span>
            <Link className="ndn-cal-live-join" href={callHref(locale, live)}>
              {strings.joinCallLabel}
            </Link>
          </p>
        )}
      </div>

      {/* The span the window covers, which is no longer a single month —
          `formatDateRange` collapses whatever the two ends share, per
          locale. `aria-live`, because it changes in response to a button
          press elsewhere on the toolbar and the reader who pressed it is not
          looking here. Present from the first render, so it announces
          changes only. */}
      {/* 2026-09-08: the range, and — while a newer one is on its way — a
          ring and a word beside it.

          Outside the live region rather than inside it. The `<p>` announces
          its own text whenever the window moves, and inserting a second
          phrase into the same region would have every arrow press read out
          as "September 2026 Updating…"; `aria-busy` on the grid below is
          what tells assistive tech the same thing without a second
          announcement. */}
      <div className="ndn-cal-range">
        <p className="ndn-cal-month" aria-live="polite">
          {formatDateRange(firstDayOnGrid ?? currentTime, lastDayOnGrid ?? currentTime, locale)}
        </p>
        {refreshing && (
          <span className="ndn-cal-refreshing">
            <Spinner size="sm" />
            {strings.refreshingLabel}
          </span>
        )}
      </div>

      {/* The one thing a failed *refresh* says. `role="alert"`, not
          `status`: something went wrong, and unlike the loading region this
          one is not what `account-a11y.setup.ts` counts down to zero. The
          month underneath it is still the last good one. */}
      {refreshFailed && <p role="alert">{strings.refreshFailedLabel}</p>}

      {/* `aria-busy` while the next window is in flight — the grid below is
          genuinely the outgoing month for those few hundred milliseconds,
          and this is how that is said to anything that is not looking at
          the ring above. No dimming to go with it: opacity over a muted
          token is how this stylesheet's own comment says text quietly drops
          below 4.5:1. */}
      <div className="ndn-cal-scroll" aria-busy={refreshing}>
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
                          {/* The one in progress is marked in both
                              renderings, so the square itself says a call is
                              open rather than only the banner above. Both
                              are still `aria-hidden`: the banner announces
                              it in words, and a second announcement of the
                              same fact from a grid cell is noise. */}
                          <span className="ndn-cal-chips" aria-hidden="true">
                            {entries.map((entry) => {
                              const entryKey = `${entry.patientId}#${entry.scheduledAt}`;
                              return (
                                <span
                                  key={entryKey}
                                  className={`ndn-cal-chip ndn-cal-chip--${entry.appointment_status}${
                                    entryKey === liveKey ? ' ndn-cal-chip--live' : ''
                                  }`}
                                >
                                  {formatTimeOfDay(entry.scheduledAt, locale)}
                                </span>
                              );
                            })}
                          </span>
                          <span className="ndn-cal-dots" aria-hidden="true">
                            {entries.map((entry) => {
                              const entryKey = `${entry.patientId}#${entry.scheduledAt}`;
                              return (
                                <span
                                  key={entryKey}
                                  className={`ndn-cal-dot ndn-cal-dot--${entry.appointment_status}${
                                    entryKey === liveKey ? ' ndn-cal-dot--live' : ''
                                  }`}
                                />
                              );
                            })}
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
                    {/* Who, before how long and what state — an appointment
                        is with a person, and that is the first thing a
                        clinician scanning a day wants off it. Each name is
                        rendered only when the API sent one; see
                        `CalendarAppointment` on why an absent name is a real
                        answer and not a gap to fill with a placeholder. */}
                    <p className="ndn-cal-meta">
                      {entry.patientName && (
                        <span>
                          {strings.patientLabel} {entry.patientName}
                        </span>
                      )}
                      {entry.clinicianName && (
                        <span>
                          {strings.clinicianLabel} {entry.clinicianName}
                        </span>
                      )}
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
                        disagree about whether a call is open.

                        `mayJoin` as well, since 2026-09-06: a helpdesk reads
                        the practice's calendar and holds no `join-call`, so
                        this row would have shown them a countdown to a call
                        they cannot enter and then a link refused on
                        arrival. See `mayJoinCalls`. */}
                    {entry.appointment_status === 'scheduled' && mayJoin && (
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
                    {/* `mayAct` as well as `isClinician`: the first says this
                        is a clinician-route calendar rather than a patient's,
                        the second says this particular role may change what
                        is on it. A helpdesk satisfies the first and not the
                        second, which is exactly "read only mode". */}
                    {isClinician && mayAct && (
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
