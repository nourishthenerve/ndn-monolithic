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
import { defaultLocale, formatDateTime } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { JoinCallCell } from './JoinCallCell.js';
import { useNow } from './useNow.js';

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
  /** 2026-09-02: the approval queue's own column and controls. */
  readonly decisionColumnLabel: string;
  readonly approveButton: string;
  readonly declineButton: string;
  readonly decideFailedLabel: string;
  /**
   * 2026-09-03: the join column's own heading and link text. **This is the
   * screen the clinician was actually on when they reported that no join
   * button appeared.** `/account/calendar` had the link and nothing in the
   * app pointed at that page; this table listed the same appointments with
   * no way to reach a call from any of them.
   */
  readonly joinCallLabel: string;
  readonly backToDashboard: string;
}

export interface PatientRecordPanelProps {
  readonly strings: PatientRecordPanelStrings;
  readonly dashboardHref: string;
  /**
   * 2026-09-03: for the appointment times in the table below — the one
   * thing on this page that is not a pre-resolved string. This screen and
   * the patient's own dashboard were formatting the same instants in two
   * different browser locales, which is what the owner read as the dates
   * being different. Optional, defaulting to `defaultLocale`.
   */
  readonly locale?: Locale;
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
  /**
   * Injectable for tests; defaults to the real current time. **A caller
   * passing this must pass a stable reference** — see `useNow.ts`, and the
   * unbounded fetch loop an inline `() => new Date()` caused here once.
   */
  readonly now?: () => Date;
  /** 2026-09-02: `POST …/appointments/{apptId}/{approve|decline}`. Injectable for tests. */
  readonly decideAppointment?: (
    accessToken: string,
    patientId: string,
    scheduledAt: string,
    decision: 'approve' | 'decline',
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

/**
 * Module scope, not an inline `() => new Date()` — the same bug fix
 * `NextAppointmentPanel`/`ClinicianCalendar` carry the note for. A fresh
 * identity per render inside a hook's dependency array is what turned a
 * clock into an unbounded fetch loop in this directory once already.
 */
const systemNow = (): Date => new Date();

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

/**
 * The appointment's own id in the path is its `scheduledAt` — the
 * `{apptId}` segment the API reads. Not the composite
 * `<patientId>#<scheduledAt>` a *call* is identified by; the two look
 * alike and are not the same, and the patient id travels in `{id}`.
 */
function defaultDecideAppointment(
  accessToken: string,
  patientId: string,
  scheduledAt: string,
  decision: 'approve' | 'decline',
): Promise<Response> {
  return fetch(
    `${contentApiUrl}/patients/${encodeURIComponent(patientId)}/appointments/${encodeURIComponent(scheduledAt)}/${decision}`,
    { method: 'POST', headers: { authorization: `Bearer ${accessToken}` } },
  );
}

function defaultFetchAppointments(accessToken: string, patientId: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}/appointments`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

export function PatientRecordPanel({
  strings,
  dashboardHref,
  locale = defaultLocale,
  patientId,
  client = defaultClient,
  fetchPatient = defaultFetchPatient,
  savePatient = defaultSavePatient,
  fetchAppointments = defaultFetchAppointments,
  now = systemNow,
  decideAppointment = defaultDecideAppointment,
}: PatientRecordPanelProps): ReactNode {
  const id = patientId ?? patientIdFromLocation();
  const [state, setState] = useState<ViewState>('loading');
  const [record, setRecord] = useState<PatientRecord | undefined>();
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [appointments, setAppointments] = useState<readonly UpcomingAppointment[] | undefined>();
  const [appointmentsFailed, setAppointmentsFailed] = useState(false);
  /** The `scheduledAt` of the row currently being decided, so one row's spinner never speaks for another's. */
  const [deciding, setDeciding] = useState<string | undefined>();
  const [decideFailed, setDecideFailed] = useState(false);
  /** Bumped to re-run the appointments effect after a decision lands. */
  const [appointmentsVersion, setAppointmentsVersion] = useState(0);
  /**
   * Whether to offer the approval controls at all.
   *
   * **2026-09-02: they used to be offered to anyone who could see a
   * pending row.** That was a deliberate departure from
   * `token-claims.ts`'s "hide on a positive answer" rule, argued on the
   * grounds that a clinician looking at their own pending request should
   * get a legible refusal rather than a row with no explanation. The owner
   * disagreed, in much the words they had used once before about the staff
   * tools: *"even a clinician can approve this appointment. This approval
   * is only reserved to principal clinician."*
   *
   * They are right, and the earlier reasoning had it backwards — a button
   * that refuses you is not an explanation, it is a worse version of not
   * being offered one. The status column already says `pending-approval`,
   * which *is* the explanation.
   *
   * **The server was never the problem and has not changed.**
   * `authz-matrix.ts`'s `Appointment approval` row denies both
   * sub-clinician columns and grants `update` to `Principal` alone, so an
   * approve from anyone else has always been a 403. This stops the control
   * being offered; it was never what stopped it working.
   *
   * Starts `true` and narrows only on a *known* non-principal role — an
   * unreadable token shows the controls and lets the server answer, the
   * same rule every other gate in this directory follows.
   */
  const [mayDecide, setMayDecide] = useState(true);
  /**
   * 2026-09-03: whether to offer a join link on this table at all.
   *
   * A separate answer from `mayDecide`, because it is a separate cell.
   * `authz-matrix.ts`'s `Appointments` row grants `join-call` to both
   * clinician columns and to `Principal`, and withholds it from `Helpdesk`
   * and `Visitor`, who hold plain `read` — and this page is deliberately
   * reachable by a helpdesk account. Offering them a link the socket will
   * refuse would be the same mistake the approval buttons made.
   *
   * Same posture as `mayDecide`: starts `true` and narrows only on a
   * *known* role that cannot join, so an unreadable token shows the link
   * and lets the server answer.
   */
  const [mayJoin, setMayJoin] = useState(true);
  /**
   * Ticks; the identity of what it is seeded from does not — see
   * `useNow.ts`, and the unbounded fetch loop that shape exists to
   * prevent. The join column has three phases and they change while the
   * page is open, which is the whole reason a clock is on this screen.
   */
  const currentTime = useNow(now);

  useEffect(() => {
    let cancelled = false;
    void client.resolve().then((state) => {
      const role = state.status === 'signed-in' ? state.session.viewerRole : undefined;
      if (!cancelled && role !== undefined) {
        setMayDecide(role === 'principal-clinician');
        setMayJoin(role === 'principal-clinician' || role === 'sub-clinician');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

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
  }, [client, fetchAppointments, id, record, appointmentsVersion]);

  /**
   * Approve or decline one pending booking, then re-read the list.
   *
   * A `403` (not the principal) and a `409` (someone decided it first)
   * land on the same message on purpose: both mean "this row is not yours
   * to change now", and both are resolved by looking again.
   */
  const decide = async (scheduledAt: string, decision: 'approve' | 'decline') => {
    setDeciding(scheduledAt);
    setDecideFailed(false);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setDeciding(undefined);
      setDecideFailed(true);
      return;
    }
    try {
      const response = await decideAppointment(accessToken, id, scheduledAt, decision);
      if (!response.ok) {
        setDecideFailed(true);
        return;
      }
      // Re-read rather than patch the row: approving changes the status,
      // and the patient's own view of "next appointment" is derived from
      // it server-side, so the list is the honest source.
      setAppointmentsVersion((current) => current + 1);
    } catch {
      setDecideFailed(true);
    } finally {
      setDeciding(undefined);
    }
  };

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
        {decideFailed && <p role="alert">{strings.decideFailedLabel}</p>}
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
                <th scope="col">{strings.decisionColumnLabel}</th>
                <th scope="col">{strings.joinCallLabel}</th>
              </tr>
            </thead>
            <tbody>
              {appointments.map((appointment) => (
                <tr key={appointment.scheduledAt}>
                  {/* The stored value is UTC ISO-8601; `<time>` carries it
                      machine-readably while the text renders in the site's
                      own locale, in whatever timezone the reader is
                      actually in. `formatDateTime`, never
                      `toLocaleString()` — see
                      `packages/i18n/src/datetime.ts`. */}
                  <td>
                    <time dateTime={appointment.scheduledAt}>
                      {formatDateTime(appointment.scheduledAt, locale)}
                    </time>
                  </td>
                  <td>
                    {appointment.durationMinutes} {strings.minutesSuffix}
                  </td>
                  <td>{appointment.appointment_status}</td>
                  {/* 2026-09-02: the approval queue, on the page where the
                      booking was made and the page the dashboard clicks
                      through to — which is what the owner meant by "visible
                      to patient dashboard to be approved". Every booking now
                      lands here first, so without a control on this screen
                      there was nowhere to move it on from.

                      Rendered for whoever can see a pending row rather than
                      guessed at by role: `Appointment approval` is
                      Principal-only and the API refuses everyone else, so a
                      clinician looking at their own pending request gets a
                      legible refusal instead of a row with no explanation. */}
                  <td>
                    {mayDecide && appointment.appointment_status === 'pending-approval' ? (
                      <>
                        <button
                          type="button"
                          disabled={deciding === appointment.scheduledAt}
                          onClick={() => void decide(appointment.scheduledAt, 'approve')}
                        >
                          {strings.approveButton}
                        </button>{' '}
                        <button
                          type="button"
                          disabled={deciding === appointment.scheduledAt}
                          onClick={() => void decide(appointment.scheduledAt, 'decline')}
                        >
                          {strings.declineButton}
                        </button>
                      </>
                    ) : null}
                  </td>
                  {/* 2026-09-03: the join column, and the reason this
                      table has one at all. The clinician who reported
                      that no join button appeared was on this page — the
                      only screen in the app that lists a *named* patient's
                      appointments — and it offered no way to reach a call
                      from any row. `/account/calendar` had the link and
                      nothing pointed at that page.

                      One component with the clinician calendar and the
                      patient's own panel, so all three show the same three
                      phases (`JoinCallCell`): a countdown before the slot,
                      a live link during it, "expired" after. Only on a
                      `scheduled` row — a pending booking has nothing to
                      join and `ws-join.ts` would refuse it, and a
                      cancelled or already-marked one is not happening. */}
                  <td>
                    {mayJoin && appointment.appointment_status === 'scheduled' ? (
                      <JoinCallCell
                        appointment={{ ...appointment, patientId: id }}
                        locale={locale}
                        now={currentTime}
                        joinCallLabel={strings.joinCallLabel}
                      />
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
