// TASK 5.5.3 step 1: the clinician half of video-calls.md's own "no
// reachable link to this page from anywhere else in the account shell"
// gap. `GET /clinicians/me/calendar` (TASK 3.4.1) has had zero frontend
// consumers until now — `CaseloadView.tsx` (TASK 2.5.3) is the only
// clinician-facing list in the account shell, and it renders a caseload
// roster with no appointment data at all, the wrong page for this link.
//
// Deliberately minimal, matching this codebase's own "read-only,
// unambiguous data source" precedent (`NextAppointmentPanel.tsx`'s own
// header): a flat list of this clinician's own appointments inside a
// fixed forward-looking window, each with a real join link where the
// appointment is still `scheduled`. No patient name — `Appointment`
// carries only `patientId`, a raw identifier, and joining that against
// `CaseloadView.tsx`'s own separate, paginated `fullName` lookup is a
// real feature, not something this gap-closing pass adds unprompted.
//
// **2026-09-01 adds the approval controls**, because this is the one screen
// where "any new appointment booked by the clinician needs to be approved
// by the principal clinician" is actionable: the calendar already lists
// every appointment in the window with its status, so a `pending-approval`
// row is already here — it just had no button on it.
//
// The buttons are rendered on every `pending-approval` row for every
// clinician who can see one, and **not hidden from a sub-clinician**. That
// is a departure from `token-claims.ts`'s "hide what the server will
// refuse" habit, and it is deliberate: a sub-clinician's own booking is
// what puts the row there, so hiding the row's controls from the person
// who created it would leave them looking at a state with no explanation.
// The status column says "waiting for approval", the API refuses a
// sub-clinician's `approve` with a 403, and the message that comes back
// says so. Offering nothing at all would be the more confusing screen.
import { formatDateTime } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { JoinCallCell } from './JoinCallCell.js';
import { useNow } from './useNow.js';

export interface CalendarEntry {
  readonly patientId: string;
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly CalendarEntry[] };

export interface ClinicianCalendarStrings {
  readonly loadingLabel: string;
  /** 2026-09-01: the approval controls' own four strings. */
  readonly approveLabel: string;
  readonly declineLabel: string;
  readonly completeLabel: string;
  readonly noShowLabel: string;
  readonly decidingLabel: string;
  readonly decideFailedLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly dateColumnLabel: string;
  readonly durationColumnLabel: string;
  readonly statusColumnLabel: string;
  readonly joinCallLabel: string;
  readonly caption: string;
}

export interface ClinicianCalendarProps {
  readonly strings: ClinicianCalendarStrings;
  /** Locale-prefixed, matching `account-routes.ts`'s own `call` entry — needed to build each join link. */
  readonly locale: Locale;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchCalendar?: (from: string, to: string, accessToken: string) => Promise<Response>;
  /** Injectable for tests; defaults to the real current time. */
  readonly now?: () => Date;
  /** 2026-09-01: `POST …/appointments/{apptId}/{approve|decline}`. Injectable for tests. */
  readonly decideAppointment?: (
    accessToken: string,
    entry: CalendarEntry,
    decision: AppointmentAction,
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

/**
 * Hoisted to module scope, and that is a bug fix rather than tidying.
 *
 * As an inline default (`now = () => new Date()`) this identity changed on
 * every render, so the `useCallback` below was rebuilt every render, so the
 * `useEffect` depending on it re-ran every render, so its `setState`
 * triggered another render: **an unbounded fetch loop against the API for
 * as long as the page was open.** Nothing caught it because this
 * directory's tests never rendered a component until 2026-09-01; the first
 * rendered test of this file crashed its worker outright.
 *
 * A module-level constant has one identity for the lifetime of the module,
 * so the effect runs once. A caller injecting its own `now` must pass a
 * stable reference for the same reason.
 */
const systemNow = (): Date => new Date();


/** How far ahead this view looks — a fixed window, not a picker; a real date-range control is a future enhancement, not this gap's own scope. */
export const CALENDAR_WINDOW_DAYS = 30;

/**
 * **How far *back* it looks, and why it must look back at all.**
 *
 * `from` was `now`, and the API turns that straight into a GSI1 range
 * query (`gsi1sk BETWEEN 'APPT#<from>' AND 'APPT#<to>'`, `dynamo-store.ts`)
 * keyed on `scheduledAt`. So an appointment left this calendar at the
 * exact instant it started — which is the exact instant its join link
 * becomes valid. The owner: *"when the item of appointment arrived the
 * 'join the call' button simply didnt appear … the dashboard simply
 * started showing the next appointment item."* On the clinician's side,
 * that is this line.
 *
 * A range query cannot express "still running" — it only knows the start
 * key — so the window has to open early enough to catch the start of
 * anything that could still be under way, and the row itself then says
 * what phase it is in (`JoinCallCell`). Twelve hours is a deliberate
 * over-estimate: nothing bounds `durationMinutes` server-side
 * (`appointment.ts` takes any positive integer), so this is a pragmatic
 * cap rather than a proof, and it is cheap to be generous — the cost of
 * being too large is a few finished rows on a 30-day calendar, and the
 * cost of being too small is the bug above coming back for a long
 * appointment only.
 *
 * The finished rows are kept rather than filtered out, and that is worth
 * a sentence: they carry the "mark as attended"/"no-show" buttons, and a
 * clinician recording what happened the moment a session ends is the
 * realistic flow. Before this change those buttons were unreachable after
 * the appointment began.
 */
export const CALENDAR_LOOKBACK_HOURS = 12;

export function calendarWindow(now: Date): { readonly from: string; readonly to: string } {
  const from = new Date(now.getTime() - CALENDAR_LOOKBACK_HOURS * 60 * 60 * 1000);
  const to = new Date(now.getTime() + CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

// `callHref` moved to `JoinCallCell.tsx` (2026-09-03) — the two
// components now share that dependency, which is what the note here used
// to say they did not. Re-exported so importers keep resolving against
// one implementation rather than two.
export { callHref } from './JoinCallCell.js';

/**
 * The appointment's own id in a path is its `scheduledAt` — the `{apptId}`
 * segment the API reads (`appointment.ts`), not the composite
 * `<patientId>#<scheduledAt>` a *call* is identified by. The two look
 * similar and are not the same; the patient id travels in `{id}`.
 */
/**
 * The four `POST` transitions this table can reach. `approve`/`decline`
 * are the principal's alone (the `Appointment approval` row); `complete`/
 * `no-show` ride `Appointments: update`, so the treating clinician has
 * them too. The server decides which; this list only says what the table
 * knows how to ask for.
 */
export type AppointmentAction = 'approve' | 'decline' | 'complete' | 'no-show';

function defaultDecideAppointment(
  accessToken: string,
  entry: CalendarEntry,
  decision: AppointmentAction,
): Promise<Response> {
  return fetch(
    `${contentApiUrl}/patients/${encodeURIComponent(entry.patientId)}/appointments/${encodeURIComponent(entry.scheduledAt)}/${decision}`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
  );
}

function defaultFetchCalendar(from: string, to: string, accessToken: string): Promise<Response> {
  const url = new URL(`${contentApiUrl}/clinicians/me/calendar`);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
}

export function ClinicianCalendar({
  strings,
  locale,
  client = defaultClient,
  fetchCalendar = defaultFetchCalendar,
  now = systemNow,
  decideAppointment = defaultDecideAppointment,
}: ClinicianCalendarProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  // Ticks on its own; `now` (the function) stays stable so this can never
  // become a dependency of the fetch. See `useNow.ts`.
  const currentTime = useNow(now);
  /** Keyed by the row's own composite id, so one row's outcome never speaks for another's. */
  const [deciding, setDeciding] = useState<Record<string, 'busy' | 'failed'>>({});
  /**
   * 2026-09-02: approve/decline are the principal's alone, and are now
   * hidden rather than offered-then-refused — see
   * `PatientRecordPanel.tsx`'s own note, which carries the reasoning and
   * the owner's words. Marking attendance is untouched: that rides
   * `Appointments: update`, which the treating clinician genuinely holds.
   *
   * Starts `true` and narrows only on a known non-principal role, so an
   * unreadable token still shows the controls and lets the server answer.
   */
  const [mayDecide, setMayDecide] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void client.resolve().then((state) => {
      const role = state.status === 'signed-in' ? state.session.viewerRole : undefined;
      if (!cancelled && role !== undefined) {
        setMayDecide(role === 'principal-clinician');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const { from, to } = calendarWindow(now());
      const response = await fetchCalendar(from, to, accessToken);
      if (response.status === 403 || response.status === 401) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly CalendarEntry[] };
      setState({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setState({ status: 'error' });
    }
  }, [client, fetchCalendar, now]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (entry: CalendarEntry, decision: AppointmentAction) => {
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
      await load();
    } catch {
      setDeciding((current) => ({ ...current, [rowKey]: 'failed' }));
    }
  };

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

  if (state.items.length === 0) {
    return <p>{strings.emptyLabel}</p>;
  }

  return (
    <table>
      <caption>{strings.caption}</caption>
      <thead>
        <tr>
          <th scope="col">{strings.dateColumnLabel}</th>
          <th scope="col">{strings.durationColumnLabel}</th>
          <th scope="col">{strings.statusColumnLabel}</th>
          <th scope="col">{strings.joinCallLabel}</th>
        </tr>
      </thead>
      <tbody>
        {state.items.map((item) => {
          const rowKey = `${item.patientId}#${item.scheduledAt}`;
          const rowState = deciding[rowKey];
          return (
            <tr key={rowKey}>
              {/* The stored value is UTC ISO-8601; `<time>` carries it
                  machine-readably while the text renders in the site's own
                  locale, in whatever timezone the reader is actually in.
                  `formatDateTime`, never `toLocaleString()` — the two
                  screens the owner compared were reading the same instants
                  and disagreeing about them. See
                  `packages/i18n/src/datetime.ts`. */}
              <td>
                <time dateTime={item.scheduledAt}>{formatDateTime(item.scheduledAt, locale)}</time>
              </td>
              <td>{item.durationMinutes}</td>
              <td>{item.appointment_status}</td>
              <td>
                {/* A `pending-approval` row gets decisions, never a join
                    link: there is nothing to join until it is confirmed,
                    and `ws-join.ts` would refuse it anyway. */}
                {mayDecide && item.appointment_status === 'pending-approval' ? (
                  <>
                    <button
                      type="button"
                      disabled={rowState === 'busy'}
                      onClick={() => void decide(item, 'approve')}
                    >
                      {rowState === 'busy' ? strings.decidingLabel : strings.approveLabel}
                    </button>{' '}
                    <button
                      type="button"
                      disabled={rowState === 'busy'}
                      onClick={() => void decide(item, 'decline')}
                    >
                      {strings.declineLabel}
                    </button>
                    {rowState === 'failed' && (
                      <span role="alert">{strings.decideFailedLabel}</span>
                    )}
                  </>
                ) : item.appointment_status === 'scheduled' ? (
                  <>
                    {/* 2026-09-03: the same three phases the patient's
                        panel shows, from one component — both sides of a
                        call face the same window and must not be able to
                        disagree about it. */}
                    <JoinCallCell
                      appointment={item}
                      locale={locale}
                      now={currentTime}
                      joinCallLabel={strings.joinCallLabel}
                    />{' '}
                    {/* Attendance, on the same row. Offered for every
                        confirmed appointment rather than only past ones:
                        a clinician marking a session the moment it ends is
                        the realistic flow, and "past" would need a clock
                        this table would then disagree with the server
                        about. The server refuses anything that is not
                        still `scheduled`. */}
                    <button
                      type="button"
                      disabled={rowState === 'busy'}
                      onClick={() => void decide(item, 'complete')}
                    >
                      {strings.completeLabel}
                    </button>{' '}
                    <button
                      type="button"
                      disabled={rowState === 'busy'}
                      onClick={() => void decide(item, 'no-show')}
                    >
                      {strings.noShowLabel}
                    </button>
                    {rowState === 'failed' && (
                      <span role="alert">{strings.decideFailedLabel}</span>
                    )}
                  </>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
