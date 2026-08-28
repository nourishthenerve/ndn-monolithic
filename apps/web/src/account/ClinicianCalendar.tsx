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
import type { Locale } from '@ndn/i18n';
import { Link } from '@ndn/ui';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

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
}

const defaultClient = createSessionClient();

/** How far ahead this view looks — a fixed window, not a picker; a real date-range control is a future enhancement, not this gap's own scope. */
export const CALENDAR_WINDOW_DAYS = 30;

export function calendarWindow(now: Date): { readonly from: string; readonly to: string } {
  const to = new Date(now.getTime() + CALENDAR_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  return { from: now.toISOString(), to: to.toISOString() };
}

/** `call.astro`'s own composite id (`ws-join.ts`'s `parseAppointmentId`) — same construction as `NextAppointmentPanel.tsx`'s own `callHref`, not re-exported from there since the two components share no other dependency. */
export function callHref(locale: Locale, entry: CalendarEntry): string {
  const appointmentId = `${entry.patientId}#${entry.scheduledAt}`;
  return `/${locale}/account/call?appointmentId=${encodeURIComponent(appointmentId)}`;
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
  now = () => new Date(),
}: ClinicianCalendarProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });

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
        {state.items.map((item) => (
          <tr key={`${item.patientId}#${item.scheduledAt}`}>
            <td>{new Date(item.scheduledAt).toLocaleString()}</td>
            <td>{item.durationMinutes}</td>
            <td>{item.appointment_status}</td>
            <td>
              {item.appointment_status === 'scheduled' ? (
                <Link href={callHref(locale, item)}>{strings.joinCallLabel}</Link>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
