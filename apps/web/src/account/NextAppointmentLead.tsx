// 2026-09-11: the next-appointment lead panel, above the calendar, on both
// dashboards — a clinician's names the patient they will see, a patient's
// names the clinician they will see.
//
// The owner, first of the clinician's box (*"show the next appointment above
// My Calender just like how it's being shown for patient"* / *"also add the
// name of the patient"*) and then its mirror (*"on patient's landing
// dashboard … also show the name of the clinician with whom he will have
// appointment with"*). The two are the same panel pointed at two endpoints,
// so they are one component rather than two that could drift.
//
// The figure and its live countdown are `NextAppointmentWhen`, and which
// appointment is "next" is `findNext` — both already built and tested for the
// patient's own panel. So whoever is reading, and whichever calendar it came
// from, the same instant is rendered the same way; this component is only the
// plumbing that fetches the right calendar and names the right counterparty.
//
//   * A **clinician** reads `GET /clinicians/me/calendar` and the box names
//     the *patient*. For a helpdesk the server answers "me" with the
//     practice's calendar (see `appointment.ts`), so their lead is the
//     practice's next appointment — the calendar they see directly below it.
//   * A **patient** reads `GET /patients/me/appointments` and the box names
//     the *clinician*. This is the same endpoint `NextAppointmentPanel` and
//     the patient's own `AppointmentCalendar` already read.
//
// The counterparty name shows only when the server disclosed one, so a
// helpdesk's practice calendar (names withheld) reads with the same two facts
// a patient's own box has, never a bare "Patient —".
//
// It renders **nothing** in every state but a loaded calendar — a reader
// whose token this bundle cannot read, or whose calendar the server refuses,
// sees no lead rather than an error card above a calendar that renders its
// own. The calendar below is the one that explains a failed fetch.
//
// Astro cannot hand a `client:only` island a function prop (they are not
// serialisable), so the page passes a plain `audience` string and this file
// picks the endpoint and the name to read from it. Tests inject
// `fetchAppointments` directly.
import type { Locale } from '@ndn/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { findNext } from './NextAppointmentPanel.js';
import type { AppointmentEntry } from './NextAppointmentPanel.js';
import { NextAppointmentWhen } from './NextAppointmentWhen.js';
import { useNow } from './useNow.js';

/**
 * How far ahead a clinician's calendar is queried. Its endpoint requires a
 * bounded range (`RANGE_REQUIRED`), and a therapy booking is never a year
 * out — a forward year is generous enough that the bound is never the reason
 * a real appointment is missed, and small enough that the one fetch stays
 * cheap. The patient's endpoint takes no range and ignores these.
 */
export const LOOKAHEAD_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Whose dashboard the lead sits on — which decides the endpoint and the name it shows. */
export type LeadAudience = 'patient' | 'clinician';

/**
 * A calendar row plus the two names the server joins on (`appointment.ts`'s
 * `withNames`). Which one the box shows depends on who is reading: a
 * clinician's box names the *patient*, a patient's the *clinician*. Absence
 * is meaningful — the server omits a name it will not disclose — so the line
 * is shown only when a name actually came back.
 */
export interface LeadAppointment extends AppointmentEntry {
  readonly patientName?: string;
  readonly clinicianName?: string;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'hidden' }
  | { readonly status: 'ready'; readonly items: readonly LeadAppointment[] };

export interface NextAppointmentLeadStrings {
  /** Matches the patient panel's own field labels, so both dashboards read the same. */
  readonly appointmentLabel: string;
  readonly durationLabel: string;
  /** The counterparty — "Patient" on a clinician's box, "Clinician" on a patient's. */
  readonly personLabel: string;
  /** Shown when there is no upcoming appointment. */
  readonly emptyLabel: string;
}

export interface NextAppointmentLeadProps {
  readonly locale: Locale;
  readonly audience: LeadAudience;
  readonly strings: NextAppointmentLeadStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to the endpoint the audience implies. */
  readonly fetchAppointments?: (from: string, to: string, accessToken: string) => Promise<Response>;
  /** Injectable for tests; must be a stable reference, for the reason `useNow.ts` documents. */
  readonly now?: () => Date;
}

const defaultClient = createSessionClient();
const systemNow = (): Date => new Date();

/** A clinician's own calendar, over the forward window. */
export function fetchClinicianCalendar(
  from: string,
  to: string,
  accessToken: string,
): Promise<Response> {
  const url = new URL(`${contentApiUrl}/clinicians/me/calendar`);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
}

/** A patient's own appointments — the endpoint takes no range, so the window is not sent. */
export function fetchPatientAppointments(
  _from: string,
  _to: string,
  accessToken: string,
): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/appointments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function NextAppointmentLead({
  locale,
  audience,
  strings,
  client = defaultClient,
  fetchAppointments = audience === 'clinician' ? fetchClinicianCalendar : fetchPatientAppointments,
  now = systemNow,
}: NextAppointmentLeadProps): ReactNode {
  // Ticks, so the panel rolls on to the following appointment the moment this
  // one ends; `now` (the function) stays stable so this can never become a
  // dependency of the fetch. See `useNow.ts`.
  const currentTime = useNow(now);
  const [state, setState] = useState<ViewState>({ status: 'loading' });

  const load = useCallback(async () => {
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'hidden' });
      return;
    }
    const start = now();
    const from = start.toISOString();
    const to = new Date(start.getTime() + LOOKAHEAD_DAYS * DAY_MS).toISOString();
    try {
      const response = await fetchAppointments(from, to, accessToken);
      if (!response.ok) {
        setState({ status: 'hidden' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly LeadAppointment[] };
      setState({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setState({ status: 'hidden' });
    }
  }, [client, fetchAppointments, now]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status !== 'ready') {
    return null;
  }

  // Sorted before `findNext` rather than trusting the endpoint's order:
  // `findNext` takes the first match in array order, and while both endpoints
  // return rows chronologically today, this panel's correctness should not
  // rest on that being the sort order of an endpoint `findNext` was not
  // written against.
  const chronological = [...state.items].sort((a, b) =>
    a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : 0,
  );
  const next = findNext(chronological, currentTime);
  // The clinician's box names the patient; the patient's names the clinician.
  const counterpartyName = next
    ? audience === 'clinician'
      ? next.patientName
      : next.clinicianName
    : undefined;

  // The same markup an `AssessmentForm` lead placement emits, so
  // `record-styles.ts`'s `.ndn-record-lead` rules dress it identically to the
  // patient's original — label above value, the appointment in three zones
  // with its countdown, and a counterparty fact between it and the length.
  return (
    <section className="ndn-record-section ndn-record-lead">
      <dl className="ndn-record-facts">
        <dt>{strings.appointmentLabel}</dt>
        <dd>{next ? <NextAppointmentWhen iso={next.scheduledAt} locale={locale} /> : '—'}</dd>
        {counterpartyName && (
          <>
            <dt>{strings.personLabel}</dt>
            <dd>{counterpartyName}</dd>
          </>
        )}
        <dt>{strings.durationLabel}</dt>
        <dd>{next ? next.durationMinutes : '—'}</dd>
      </dl>
      {!next && <p className="ndn-record-note">{strings.emptyLabel}</p>}
    </section>
  );
}
