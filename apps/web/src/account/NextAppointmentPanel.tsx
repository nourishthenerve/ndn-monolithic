// TASK 3.4.1 step 6: a read-only "next appointment" panel for the
// signed-in patient. Same posture as every other account-page island
// (`PatientProfile.tsx`/`ClinicalRecordTimeline.tsx`): rendered only
// inside `RequireAuth`, and a `403` from the API is an ordinary, expected
// outcome — the server-side `can()` check (`appointment.ts`) is the real
// boundary, not this component's role guess.
//
// `GET /patients/me/appointments` already returns every appointment in
// chronological order (main-table sort-key order); "next" is the first
// one still `scheduled` whose `scheduledAt` has not yet passed — a plain
// filter over already-authorised-to-see data, not the client-side
// private-field filtering `private-field-boundary.md` warns against
// (`Appointment` carries no `private{}` field at all, today or planned).
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
import { useNow } from './useNow.js';

export interface AppointmentEntry {
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
  /**
   * TASK 5.5.3 step 1: the field this component always received but never
   * read — `GET /patients/me/appointments`'s own response already carries
   * it (`Appointment`'s own shape, `packages/shared-types/src/appointment.ts`;
   * no `private{}` split on this entity, confirmed against `projection.ts`).
   * `call.astro`'s own appointment id is `<patientId>#<scheduledAt>`
   * (`ws-join.ts`'s `parseAppointmentId`) — this is the other half.
   */
  readonly patientId: string;
}

/**
 * **2026-09-03: `ready` holds the whole list, not the one row that was
 * next when the fetch landed.** Which appointment is "next" is a question
 * about the clock, and this panel already has a ticking one for its
 * countdown — freezing the answer at fetch time meant a page left open
 * kept naming an appointment that had finished, and would never roll on to
 * the following one without a reload. Deriving it per render costs a
 * `find` over a handful of rows and cannot go stale.
 */
type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly AppointmentEntry[] };

export interface NextAppointmentPanelStrings {
  readonly heading: string;
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly durationLabel: string;
  readonly joinCallLabel: string;
}

export interface NextAppointmentPanelProps {
  readonly strings: NextAppointmentPanelStrings;
  /** Locale-prefixed, matching `account-routes.ts`'s own `call` entry — needed to build the join link. */
  readonly locale: Locale;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchAppointments?: (accessToken: string) => Promise<Response>;
  /** Injectable for tests; defaults to the real current time. */
  readonly now?: () => Date;
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


function defaultFetchAppointments(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/appointments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

/**
 * The first confirmed appointment that has not finished — **including the
 * one happening right now**, which is the whole of the 2026-09-03 fix.
 *
 * This used to read `item.scheduledAt >= nowIso`, and so stopped
 * recognising an appointment at the exact instant it started, which is the
 * exact instant its join link becomes valid. The patient watched the panel
 * skip straight past the call they were waiting for and name the one after
 * it. See `isLiveOrUpcoming`.
 *
 * `find`, not a sort: `GET /patients/me/appointments` returns main-table
 * sort-key order, which is chronological by `scheduledAt` — the first
 * match is therefore the earliest one.
 */
export function findNext(
  items: readonly AppointmentEntry[],
  now: Date,
): AppointmentEntry | undefined {
  return items.find(
    (item) =>
      item.appointment_status === 'scheduled' &&
      isLiveOrUpcoming(item.scheduledAt, item.durationMinutes, now),
  );
}

// `callHref` moved to `JoinCallCell.tsx` (2026-09-03), which is now the
// only thing that builds this link — re-exported so existing importers and
// tests keep working against one implementation rather than two.
export { callHref } from './JoinCallCell.js';

export function NextAppointmentPanel({
  strings,
  locale,
  client = defaultClient,
  fetchAppointments = defaultFetchAppointments,
  now = systemNow,
}: NextAppointmentPanelProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  // Ticks; `now` itself does not. See `useNow.ts` for why that distinction
  // is the whole point.
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
      if (response.status === 403 || response.status === 401) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly AppointmentEntry[] };
      // Stored whole. Which of these is "next" is decided at render time
      // against the ticking clock — see `ViewState`'s own note.
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

  // Re-derived on every tick of `currentTime`, so the panel hands over to
  // the following appointment the moment this one ends — no reload.
  const next = findNext(state.items, currentTime);

  return (
    <section aria-labelledby="next-appointment-heading">
      <Heading level={2} id="next-appointment-heading">
        {strings.heading}
      </Heading>
      {next ? (
        <p>
          {/* The stored value is UTC ISO-8601; `<time>` carries it
              machine-readably while the text renders in the site's own
              locale, in whatever timezone the reader is actually in.
              `formatDateTime`, never `toLocaleString()` — see
              `packages/i18n/src/datetime.ts` for the two screens that
              disagreed about the same appointment. */}
          <time dateTime={next.scheduledAt}>{formatDateTime(next.scheduledAt, locale)}</time>{' '}
          — {strings.durationLabel} {next.durationMinutes}
          {' — '}
          {/* 2026-09-03: the link only exists while the slot does. Before
              it, a countdown; after it, "expired". The three states are
              the same three `ws-join.ts` enforces, so what a patient can
              press and what the server will accept agree — a link that is
              refused on arrival is worse than no link, because the patient
              has already believed in it. */}
          <JoinCallCell
            appointment={next}
            locale={locale}
            now={currentTime}
            joinCallLabel={strings.joinCallLabel}
          />
        </p>
      ) : (
        <p>{strings.emptyLabel}</p>
      )}
    </section>
  );
}
