// 2026-09-01: booking an appointment. The owner: *"i see the calender
// section but there is no button to edit / add a new calender date for
// appointment."*
//
// There was no such control **anywhere on the site**. `POST
// /patients/{id}/appointments` has existed since TASK 3.4.1 and had no
// frontend consumer at all, so every appointment in the system had to be
// written by hand. The assessment form's calendar section shows the next
// booking and counts the ones that happened; nothing made one.
//
// **It lives on the patient's record page, not on `/account/calendar`.**
// A booking needs a patient, and the clinician calendar has none — it
// spans every patient in a date window, so "book" there would have to ask
// *which* patient and duplicate the dashboard's own job of choosing one.
// On the record page the patient is already chosen, and this sits directly
// under the list of that patient's existing appointments.
//
// It deliberately does **not** re-check the caller's role. A helpdesk
// account can open this page, and `Appointments: R` is all they hold — so
// the server answers 403 and this says so. That is the same posture every
// island in this directory takes: the boundary is `can()`, and a form that
// guessed would only ever guess differently from it.
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

type BookingState = 'idle' | 'busy' | 'booked' | 'conflict' | 'forbidden' | 'failed';

export interface AppointmentBookingStrings {
  readonly heading: string;
  readonly whenLabel: string;
  readonly durationLabel: string;
  readonly submitLabel: string;
  readonly busyLabel: string;
  readonly successLabel: string;
  /** Shown alongside success: a clinician's booking is not confirmed until the principal approves it. */
  readonly pendingNoticeLabel: string;
  readonly conflictLabel: string;
  readonly forbiddenLabel: string;
  readonly failedLabel: string;
}

export interface AppointmentBookingProps {
  readonly strings: AppointmentBookingStrings;
  /**
   * Injectable for tests; defaults to the `?id=` on the current URL — the
   * same one `PatientRecordPanel` and `AssessmentForm` resolve on this
   * page, so all three always act on the same patient.
   */
  readonly patientId?: string;
  /** Called after a booking lands, so the surrounding page can re-read its appointment list. */
  readonly onBooked?: () => void;
  readonly client?: SessionClient;
  readonly bookAppointment?: (
    accessToken: string,
    patientId: string,
    body: { readonly scheduledAt: string; readonly durationMinutes: number },
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

/** The default length of a session, in minutes — a starting value in the field, never a constraint the API enforces. */
export const DEFAULT_APPOINTMENT_MINUTES = 30;

function defaultBookAppointment(
  accessToken: string,
  patientId: string,
  body: { readonly scheduledAt: string; readonly durationMinutes: number },
): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}/appointments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * `datetime-local` yields a zoneless string (`2026-09-05T10:00`). `new
 * Date(...)` reads that as **local** time and `toISOString()` converts it
 * to the UTC instant the API stores — which is what the clinician meant by
 * the time they typed into their own browser.
 *
 * Exported so the conversion is testable on its own: getting it wrong
 * moves every appointment by the reader's UTC offset, which is the kind of
 * bug that only shows up for whoever is not on UTC.
 */
export function toUtcInstant(localDateTime: string): string | undefined {
  const parsed = new Date(localDateTime);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function patientIdFromLocation(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('id') ?? '';
}

export function AppointmentBooking({
  strings,
  patientId,
  onBooked,
  client = defaultClient,
  bookAppointment = defaultBookAppointment,
}: AppointmentBookingProps): ReactNode {
  const id = patientId ?? patientIdFromLocation();
  const [when, setWhen] = useState('');
  const [durationMinutes, setDurationMinutes] = useState(DEFAULT_APPOINTMENT_MINUTES);
  const [state, setState] = useState<BookingState>('idle');

  const submit = async () => {
    const scheduledAt = toUtcInstant(when);
    if (!scheduledAt) {
      setState('failed');
      return;
    }
    setState('busy');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    try {
      const response = await bookAppointment(accessToken, id, {
        scheduledAt,
        durationMinutes,
      });
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      // The patient already has an appointment at that exact instant —
      // the store refuses it rather than overwriting.
      if (response.status === 409) {
        setState('conflict');
        return;
      }
      if (!response.ok) {
        setState('failed');
        return;
      }
      setState('booked');
      setWhen('');
      onBooked?.();
    } catch {
      setState('failed');
    }
  };

  const busy = state === 'busy';

  // No patient chosen — the record page above is already saying so, and a
  // booking form with nothing to book against would only add a second
  // failure to the same screen.
  if (!id) {
    return null;
  }

  return (
    <section aria-labelledby="appointment-booking-heading">
      <h2 id="appointment-booking-heading">{strings.heading}</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p>
          <label htmlFor="appointment-when">{strings.whenLabel}</label>
          <input
            id="appointment-when"
            type="datetime-local"
            required
            value={when}
            disabled={busy}
            onChange={(event) => {
              setWhen(event.target.value);
              setState('idle');
            }}
          />
        </p>
        <p>
          <label htmlFor="appointment-duration">{strings.durationLabel}</label>
          <input
            id="appointment-duration"
            type="number"
            min={5}
            step={5}
            required
            value={durationMinutes}
            disabled={busy}
            onChange={(event) => {
              setDurationMinutes(Number(event.target.value));
              setState('idle');
            }}
          />
        </p>
        <button type="submit" disabled={busy || when === ''}>
          {busy ? strings.busyLabel : strings.submitLabel}
        </button>
        {/* A sub-clinician's booking lands `pending-approval`, so saying
            only "booked" would overstate it. The principal's own booking
            is confirmed immediately, and for them the notice is merely
            redundant rather than wrong — which is a better trade than
            guessing the reader's role to decide whether to show it. */}
        {state === 'booked' && (
          <>
            <span role="status">{strings.successLabel}</span> <span>{strings.pendingNoticeLabel}</span>
          </>
        )}
        {state === 'conflict' && <span role="alert">{strings.conflictLabel}</span>}
        {state === 'forbidden' && <span role="alert">{strings.forbiddenLabel}</span>}
        {state === 'failed' && <span role="alert">{strings.failedLabel}</span>}
      </form>
    </section>
  );
}
