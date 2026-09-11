// 2026-09-10: the clinician's next appointment, in the same lead panel the
// patient sees above their own calendar.
//
// The owner: *"for clinician landing dashboard, show the next appointment
// above My Calender just like how it's being shown for patient."*
//
// The patient's lead is an `AssessmentForm` placement reading the derived
// `nextAppointmentAt` off their own record's calendar summary. A clinician
// has no assessment record, so this derives the same thing from the calendar
// the clinician already reads — `GET /clinicians/me/calendar`, the endpoint
// `AppointmentCalendar` uses. For a helpdesk the server answers "me" with the
// *practice's* calendar (see `appointment.ts`), so their lead is the
// practice's next appointment, which is exactly the calendar they see
// directly below it.
//
// **Nothing about the figure itself is new.** The three zoned times and the
// live countdown are `NextAppointmentWhen`, and which appointment is "next"
// is `findNext` — both already built and tested for the patient's own panel.
// So a patient and their clinician read the same instant rendered the same
// way; this component is only the plumbing that hands the clinician's own
// next appointment to the same view.
//
// It renders **nothing** in every state but a loaded calendar — a clinician
// whose token this bundle cannot read, or whose calendar the server refuses,
// sees no lead at all rather than an error card above a calendar that will
// render its own. The calendar below is the one that explains a fetch that
// failed; a second copy of that message is noise.
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
 * How far ahead to look for the next appointment. The clinician calendar
 * endpoint requires a bounded range (`RANGE_REQUIRED`), and a therapy
 * booking is never a year out — a forward year is generous enough that the
 * bound is never the reason a real appointment is missed, and small enough
 * that the one fetch stays cheap.
 */
export const LOOKAHEAD_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The calendar row `AppointmentEntry` plus the one field this panel reads that
 * a patient's own next-appointment rows never carry: **who the appointment is
 * with**. `GET /clinicians/me/calendar` joins it on (`appointment.ts`'s
 * `withNames`) and omits it where it may not be disclosed — so its absence is
 * meaningful, and the "Patient" line is shown only when a name actually came
 * back, never as "Patient —".
 */
export interface ClinicianAppointment extends AppointmentEntry {
  readonly patientName?: string;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'hidden' }
  | { readonly status: 'ready'; readonly items: readonly ClinicianAppointment[] };

export interface ClinicianNextAppointmentStrings {
  /** Matches the patient panel's own field labels, so the two dashboards read the same. */
  readonly appointmentLabel: string;
  readonly durationLabel: string;
  /** The patient the next appointment is with — the one fact the clinician's box adds over the patient's. */
  readonly patientLabel: string;
  /** Shown when the clinician has no upcoming appointment — the patient panel's own empty note. */
  readonly emptyLabel: string;
}

export interface ClinicianNextAppointmentProps {
  readonly locale: Locale;
  readonly strings: ClinicianNextAppointmentStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real authorised fetch of the clinician's own calendar. */
  readonly fetchCalendar?: (from: string, to: string, accessToken: string) => Promise<Response>;
  /** Injectable for tests; must be a stable reference, for the reason `useNow.ts` documents. */
  readonly now?: () => Date;
}

const defaultClient = createSessionClient();
const systemNow = (): Date => new Date();

function defaultFetchCalendar(from: string, to: string, accessToken: string): Promise<Response> {
  const url = new URL(`${contentApiUrl}/clinicians/me/calendar`);
  url.searchParams.set('from', from);
  url.searchParams.set('to', to);
  return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
}

export function ClinicianNextAppointment({
  locale,
  strings,
  client = defaultClient,
  fetchCalendar = defaultFetchCalendar,
  now = systemNow,
}: ClinicianNextAppointmentProps): ReactNode {
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
      const response = await fetchCalendar(from, to, accessToken);
      if (!response.ok) {
        setState({ status: 'hidden' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly ClinicianAppointment[] };
      setState({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setState({ status: 'hidden' });
    }
  }, [client, fetchCalendar, now]);

  useEffect(() => {
    void load();
  }, [load]);

  if (state.status !== 'ready') {
    return null;
  }

  // Sorted before `findNext` rather than trusting the endpoint's order:
  // `findNext` takes the first match in array order, and while the calendar
  // GSI returns rows chronologically today, this panel's correctness should
  // not rest on that being the sort order of a different endpoint than the
  // one `findNext` was written for.
  const chronological = [...state.items].sort((a, b) =>
    a.scheduledAt < b.scheduledAt ? -1 : a.scheduledAt > b.scheduledAt ? 1 : 0,
  );
  const next = findNext(chronological, currentTime);

  // The same markup an `AssessmentForm` lead placement emits, so
  // `record-styles.ts`'s `.ndn-record-lead` rules dress it identically to the
  // patient's — label above value, the appointment in three zones with its
  // countdown. The one addition over the patient's box is a "Patient" fact:
  // the clinician's box answers *who* the appointment is with, which the
  // patient's own never needs to. It renders only when the server disclosed a
  // name, so a helpdesk's practice calendar (names withheld) shows the same
  // two facts the patient does rather than a column of "Patient —".
  return (
    <section className="ndn-record-section ndn-record-lead">
      <dl className="ndn-record-facts">
        <dt>{strings.appointmentLabel}</dt>
        <dd>{next ? <NextAppointmentWhen iso={next.scheduledAt} locale={locale} /> : '—'}</dd>
        {next?.patientName && (
          <>
            <dt>{strings.patientLabel}</dt>
            <dd>{next.patientName}</dd>
          </>
        )}
        <dt>{strings.durationLabel}</dt>
        <dd>{next ? next.durationMinutes : '—'}</dd>
      </dl>
      {!next && <p className="ndn-record-note">{strings.emptyLabel}</p>}
    </section>
  );
}
