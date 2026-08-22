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
import { Heading } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export interface AppointmentEntry {
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly next: AppointmentEntry | undefined };

export interface NextAppointmentPanelStrings {
  readonly heading: string;
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly durationLabel: string;
}

export interface NextAppointmentPanelProps {
  readonly strings: NextAppointmentPanelStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchAppointments?: (accessToken: string) => Promise<Response>;
  /** Injectable for tests; defaults to the real current time. */
  readonly now?: () => Date;
}

const defaultClient = createSessionClient();

function defaultFetchAppointments(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/appointments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function findNext(items: readonly AppointmentEntry[], nowIso: string): AppointmentEntry | undefined {
  return items.find(
    (item) => item.appointment_status === 'scheduled' && item.scheduledAt >= nowIso,
  );
}

export function NextAppointmentPanel({
  strings,
  client = defaultClient,
  fetchAppointments = defaultFetchAppointments,
  now = () => new Date(),
}: NextAppointmentPanelProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

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
      setState({ status: 'ready', next: findNext(payload.items ?? [], now().toISOString()) });
    } catch {
      setState({ status: 'error' });
    }
  }, [client, fetchAppointments, now]);

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

  return (
    <section aria-labelledby="next-appointment-heading">
      <Heading level={2} id="next-appointment-heading">
        {strings.heading}
      </Heading>
      {state.next ? (
        <p>
          {new Date(state.next.scheduledAt).toLocaleString()} — {strings.durationLabel}{' '}
          {state.next.durationMinutes}
        </p>
      ) : (
        <p>{strings.emptyLabel}</p>
      )}
    </section>
  );
}
