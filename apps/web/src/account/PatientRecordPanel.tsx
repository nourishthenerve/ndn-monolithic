// 2026-08-31: one patient, seen and edited by staff — the owner's *"the
// helpdesk should be able to view patient dashboard and patient details
// but can only update the details"*, and *"providing other details from
// the dashboard like upcoming appointments etc"*.
//
// This was the one genuine gap behind that report. `/account/patient`
// reads `/patients/me` and is the patient's own page; the dashboard
// listed patients but linked to nothing. There was no screen anywhere
// that showed staff a *named* patient. This is it, reached from the
// dashboard with `?id=<patientId>`.
//
// **What it deliberately does not show.** No diagnosis, no care plan, no
// assessments, no message thread — the rows `Helpdesk` is denied in
// docs/plan/04-data-model-rbac.md. The principal is denied none of them
// and could be shown all of them here, but a screen whose content
// silently differs by role is a screen nobody can reason about; the
// clinical surfaces stay on the clinical pages. What this shows is what
// both roles can act on: who the patient is, what standing their account
// has, who is responsible for them, and when they are next seen.
//
// Appointments are read-only here even for the principal, who may create
// them: scheduling belongs with a calendar, not with a details form.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export type PatientAccountStatus = 'pending' | 'approved' | 'declined' | 'suspended';

interface PatientRecord {
  readonly id: string;
  readonly account_status: PatientAccountStatus;
  readonly assigned_clinician_id?: string;
  readonly personal: {
    readonly fullName: string;
    readonly email: string;
    readonly phone?: string;
    readonly marketingOptIn: boolean;
  };
}

interface UpcomingAppointment {
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
}

type ViewState = 'loading' | 'ready' | 'saving' | 'saved' | 'forbidden' | 'notFound' | 'error';

export interface PatientRecordPanelStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly notFoundLabel: string;
  readonly errorLabel: string;
  readonly missingIdLabel: string;
  readonly detailsHeading: string;
  readonly fullNameLabel: string;
  readonly emailLabel: string;
  readonly phoneLabel: string;
  readonly marketingOptInLabel: string;
  readonly statusLabel: string;
  readonly assignedClinicianLabel: string;
  readonly unassignedLabel: string;
  readonly saveButton: string;
  readonly saving: string;
  readonly savedMessage: string;
  readonly statusPendingLabel: string;
  readonly statusApprovedLabel: string;
  readonly statusDeclinedLabel: string;
  readonly statusSuspendedLabel: string;
  readonly appointmentsHeading: string;
  readonly appointmentsEmpty: string;
  readonly appointmentsError: string;
  readonly whenColumnLabel: string;
  readonly durationColumnLabel: string;
  readonly appointmentStatusColumnLabel: string;
  readonly minutesSuffix: string;
  readonly backToDashboard: string;
}

export interface PatientRecordPanelProps {
  readonly strings: PatientRecordPanelStrings;
  readonly dashboardHref: string;
  /** Injectable for tests; defaults to the `?id=` on the current URL. */
  readonly patientId?: string;
  readonly client?: SessionClient;
  readonly fetchPatient?: (accessToken: string, patientId: string) => Promise<Response>;
  readonly savePatient?: (
    accessToken: string,
    patientId: string,
    patch: { readonly personal: Record<string, unknown> },
  ) => Promise<Response>;
  readonly fetchAppointments?: (accessToken: string, patientId: string) => Promise<Response>;
}

const defaultClient = createSessionClient();

function patientIdFromLocation(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('id') ?? '';
}

function defaultFetchPatient(accessToken: string, patientId: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultSavePatient(
  accessToken: string,
  patientId: string,
  patch: { readonly personal: Record<string, unknown> },
): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

function defaultFetchAppointments(accessToken: string, patientId: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}/appointments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function PatientRecordPanel({
  strings,
  dashboardHref,
  patientId,
  client = defaultClient,
  fetchPatient = defaultFetchPatient,
  savePatient = defaultSavePatient,
  fetchAppointments = defaultFetchAppointments,
}: PatientRecordPanelProps): ReactNode {
  const id = patientId ?? patientIdFromLocation();
  const [state, setState] = useState<ViewState>('loading');
  const [record, setRecord] = useState<PatientRecord | undefined>();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [appointments, setAppointments] = useState<readonly UpcomingAppointment[] | undefined>();
  const [appointmentsFailed, setAppointmentsFailed] = useState(false);

  const load = useCallback(async () => {
    if (!id) {
      return;
    }
    setState('loading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    try {
      const response = await fetchPatient(accessToken, id);
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      if (response.status === 404) {
        setState('notFound');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      const payload = (await response.json()) as { item?: PatientRecord };
      if (!payload.item) {
        setState('error');
        return;
      }
      setRecord(payload.item);
      setFullName(payload.item.personal.fullName);
      setPhone(payload.item.personal.phone ?? '');
      setMarketingOptIn(payload.item.personal.marketingOptIn);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchPatient, id]);

  useEffect(() => {
    void load();
  }, [load]);

  // A separate read, and a separate failure: a helpdesk account that
  // cannot reach appointments must still get the details page, not an
  // error screen. Loaded once the record itself is known to exist.
  useEffect(() => {
    if (!id || !record) {
      return;
    }
    let cancelled = false;
    const loadAppointments = async () => {
      const accessToken = await client.authorization();
      if (!accessToken) {
        return;
      }
      try {
        const response = await fetchAppointments(accessToken, id);
        if (!response.ok) {
          if (!cancelled) setAppointmentsFailed(true);
          return;
        }
        const payload = (await response.json()) as { items?: readonly UpcomingAppointment[] };
        if (!cancelled) {
          setAppointments(payload.items ?? []);
        }
      } catch {
        if (!cancelled) setAppointmentsFailed(true);
      }
    };
    void loadAppointments();
    return () => {
      cancelled = true;
    };
  }, [client, fetchAppointments, id, record]);

  const statusLabel = (accountStatus: PatientAccountStatus): string => {
    switch (accountStatus) {
      case 'approved':
        return strings.statusApprovedLabel;
      case 'pending':
        return strings.statusPendingLabel;
      case 'declined':
        return strings.statusDeclinedLabel;
      case 'suspended':
        return strings.statusSuspendedLabel;
    }
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = fullName.trim();
    if (!name) {
      return;
    }
    setState('saving');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    // A blank optional field is sent as absent, never as `''` — the same
    // rule `patient-admin-request.ts` states: "no phone was given" and
    // "phone is blank" are different facts.
    const trimmedPhone = phone.trim();
    try {
      const response = await savePatient(accessToken, id, {
        personal: {
          fullName: name,
          marketingOptIn,
          ...(trimmedPhone ? { phone: trimmedPhone } : {}),
        },
      });
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      setState('saved');
    } catch {
      setState('error');
    }
  };

  if (!id) {
    return <p role="alert">{strings.missingIdLabel}</p>;
  }
  if (state === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (state === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (state === 'notFound') {
    return <p role="alert">{strings.notFoundLabel}</p>;
  }
  if (state === 'error' && !record) {
    return <p role="alert">{strings.errorLabel}</p>;
  }
  if (!record) {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const isSaving = state === 'saving';

  return (
    <>
      <p>
        <a href={dashboardHref}>{strings.backToDashboard}</a>
      </p>

      <section>
        <h2>{strings.detailsHeading}</h2>
        <dl>
          {/* Read-only facts, above the form: the email is bound to the
              Cognito identity and cannot be edited here, and status and
              assignment are the principal's to change from the dashboard,
              not anyone's to type. */}
          <dt>{strings.emailLabel}</dt>
          <dd>{record.personal.email}</dd>
          <dt>{strings.statusLabel}</dt>
          <dd>{statusLabel(record.account_status)}</dd>
          <dt>{strings.assignedClinicianLabel}</dt>
          <dd>{record.assigned_clinician_id ?? strings.unassignedLabel}</dd>
        </dl>
        <form onSubmit={(event) => void handleSave(event)}>
          <p>
            <label htmlFor="record-full-name">{strings.fullNameLabel}</label>
            <input
              id="record-full-name"
              type="text"
              required
              disabled={isSaving}
              value={fullName}
              onChange={(event) => {
                setFullName(event.target.value);
                setState((current) => (current === 'saved' ? 'ready' : current));
              }}
            />
          </p>
          <p>
            <label htmlFor="record-phone">{strings.phoneLabel}</label>
            <input
              id="record-phone"
              type="tel"
              disabled={isSaving}
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                setState((current) => (current === 'saved' ? 'ready' : current));
              }}
            />
          </p>
          <p>
            <label htmlFor="record-marketing">
              <input
                id="record-marketing"
                type="checkbox"
                disabled={isSaving}
                checked={marketingOptIn}
                onChange={(event) => {
                  setMarketingOptIn(event.target.checked);
                  setState((current) => (current === 'saved' ? 'ready' : current));
                }}
              />{' '}
              {strings.marketingOptInLabel}
            </label>
          </p>
          {state === 'error' && <p role="alert">{strings.errorLabel}</p>}
          {state === 'saved' && <p role="status">{strings.savedMessage}</p>}
          <button type="submit" disabled={isSaving || fullName.trim().length === 0}>
            {isSaving ? strings.saving : strings.saveButton}
          </button>
        </form>
      </section>

      <section>
        <h2>{strings.appointmentsHeading}</h2>
        {appointmentsFailed && <p role="alert">{strings.appointmentsError}</p>}
        {!appointmentsFailed && appointments && appointments.length === 0 && (
          <p>{strings.appointmentsEmpty}</p>
        )}
        {!appointmentsFailed && appointments && appointments.length > 0 && (
          <table>
            <caption>{strings.appointmentsHeading}</caption>
            <thead>
              <tr>
                <th scope="col">{strings.whenColumnLabel}</th>
                <th scope="col">{strings.durationColumnLabel}</th>
                <th scope="col">{strings.appointmentStatusColumnLabel}</th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((appointment) => (
                <tr key={appointment.scheduledAt}>
                  {/* The stored value is UTC ISO-8601; `<time>` carries it
                      machine-readably while the text renders in whatever
                      timezone the reader is actually in. */}
                  <td>
                    <time dateTime={appointment.scheduledAt}>
                      {new Date(appointment.scheduledAt).toLocaleString()}
                    </time>
                  </td>
                  <td>
                    {appointment.durationMinutes} {strings.minutesSuffix}
                  </td>
                  <td>{appointment.appointment_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
