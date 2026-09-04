// 2026-09-04: the patient's own calendar. The owner: *"for principal
// clinician and normal clinician there is My Calendar button. Make similar
// My Calender button for patient where he can see upcoming appointments
// and easily join from there."*
//
// **What the patient had instead.** `NextAppointmentPanel` shows exactly
// one appointment — the next one — buried below the profile form on
// `/account/patient`, and `PatientNotifications` shows a feed of
// "confirmed" notices on the dashboard. Neither is a list of what is
// coming: a patient with four appointments booked could see one of them,
// and the only way to learn about the rest was to wait for each to become
// "next". The clinician has had the equivalent page since TASK 5.5.3.
//
// Deliberately the clinician calendar's shape, not a new one — same table,
// same `JoinCallCell`, same three phases — because both parties are
// looking at the same appointments and the pages should not teach two
// different vocabularies for them. What it does *not* borrow is every
// control: approve/decline and attendance are the clinician's
// (`authz-matrix.ts`'s `Appointment approval` row and `Appointments:
// update`), and the API refuses a patient both.
//
// **Confirmed appointments only.** A `pending-approval` booking is not
// shown, which is the same rule the notification feed and
// `summariseCalendar` already keep, and it is the owner's own from
// 2026-09-02: *"I dont want to see 'Your clinician has requested an
// appointment. It is waiting to be confirmed.' … I only want to see
// confirmed appointments."* A slot the principal has not approved is not
// something to turn up to, so it is not on the calendar.
import { formatDateTime } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Heading } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { isLiveOrUpcoming } from './join-window.js';
import { JoinCallCell } from './JoinCallCell.js';
import type { AppointmentEntry } from './NextAppointmentPanel.js';
import { useNow } from './useNow.js';

export type { AppointmentEntry };

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  /**
   * The whole list, exactly as `NextAppointmentPanel` now holds it and for
   * the same reason: which appointments are still ahead is a question about
   * the clock, and this component already ticks one. Deciding it at fetch
   * time would leave a page open overnight still listing yesterday.
   */
  | { readonly status: 'ready'; readonly items: readonly AppointmentEntry[] };

export interface PatientAppointmentsStrings {
  readonly heading: string;
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly dateColumnLabel: string;
  readonly durationColumnLabel: string;
  readonly joinCallLabel: string;
  readonly caption: string;
}

export interface PatientAppointmentsProps {
  readonly strings: PatientAppointmentsStrings;
  /** Locale-prefixed, matching `account-routes.ts`'s own `call` entry — needed to build each join link. */
  readonly locale: Locale;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchAppointments?: (accessToken: string) => Promise<Response>;
  /**
   * Injectable for tests; defaults to the real current time. **A caller
   * passing this must pass a stable reference** — see `useNow.ts`, and the
   * unbounded fetch loop an inline `() => new Date()` caused in this
   * directory once already.
   */
  readonly now?: () => Date;
}

const defaultClient = createSessionClient();

/** Module scope, one identity for the lifetime of the module — see `useNow.ts`. */
const systemNow = (): Date => new Date();

function defaultFetchAppointments(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/appointments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

/**
 * Everything still ahead of the patient — confirmed, and not yet finished.
 *
 * "Not yet finished", never "starts in the future": an appointment that is
 * happening *right now* is the one the patient most needs on this page,
 * because it is the only moment its join link works. That distinction is
 * the whole of the 2026-09-03 fix, and `isLiveOrUpcoming` is the same test
 * `findNext` and the clinician's own calendar apply.
 *
 * `GET /patients/me/appointments` returns main-table sort-key order, which
 * is chronological, so the filtered list needs no sort of its own.
 */
export function upcomingOf(
  items: readonly AppointmentEntry[],
  now: Date,
): readonly AppointmentEntry[] {
  return items.filter(
    (item) =>
      item.appointment_status === 'scheduled' &&
      isLiveOrUpcoming(item.scheduledAt, item.durationMinutes, now),
  );
}

export function PatientAppointments({
  strings,
  locale,
  client = defaultClient,
  fetchAppointments = defaultFetchAppointments,
  now = systemNow,
}: PatientAppointmentsProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  // Ticks; `now` itself does not. A countdown re-render must never be able
  // to become a re-fetch — see `useNow.ts`.
  const currentTime = useNow(now);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await fetchAppointments(accessToken);
      // A clinician who lands here gets a 403, which is an ordinary
      // outcome rather than an error — the same posture every account
      // island in this codebase takes.
      if (response.status === 401 || response.status === 403) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly AppointmentEntry[] };
      setState({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setState({ status: 'error' });
    }
  }, [client, fetchAppointments]);

  useEffect(() => {
    void load();
  }, [load]);

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

  // Re-derived on every tick, so a row leaves the moment its slot ends and
  // the page never needs a reload to stay honest.
  const upcoming = upcomingOf(state.items, currentTime);

  return (
    <section aria-labelledby="patient-appointments-heading">
      <Heading level={2} id="patient-appointments-heading">
        {strings.heading}
      </Heading>
      {upcoming.length === 0 ? (
        <p>{strings.emptyLabel}</p>
      ) : (
        <table>
          <caption>{strings.caption}</caption>
          <thead>
            <tr>
              <th scope="col">{strings.dateColumnLabel}</th>
              <th scope="col">{strings.durationColumnLabel}</th>
              <th scope="col">{strings.joinCallLabel}</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.map((item) => (
              <tr key={item.scheduledAt}>
                {/* The stored value is UTC ISO-8601; `<time>` carries it
                    machine-readably while the text renders in the site's
                    own locale, in whatever timezone the reader is actually
                    in. See `packages/i18n/src/datetime.ts`. */}
                <td>
                  <time dateTime={item.scheduledAt}>
                    {formatDateTime(item.scheduledAt, locale)}
                  </time>
                </td>
                <td>{item.durationMinutes}</td>
                {/* The same three phases the clinician's calendar shows,
                    from the same component: a countdown before the slot, a
                    live link during it, "expired" after. Both sides of a
                    call face one window and must not be able to disagree
                    about it. */}
                <td>
                  <JoinCallCell
                    appointment={item}
                    locale={locale}
                    now={currentTime}
                    joinCallLabel={strings.joinCallLabel}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
