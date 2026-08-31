// D-29 (2026-08-29): the staff-facing form for `POST /patients` and
// `POST /patients/{id}/reset-password` — named in
// docs/runbooks/patient-account-provisioning.md as "the obvious next
// increment once the API is proven live," built now that it has been
// (that runbook's own "Status update" section). Rendered only inside
// `RequireAuth` (patient-admin.astro), same posture as
// `CaseloadView.tsx`/`MessageThread.tsx`: a 403 here is an ordinary,
// expected outcome — the server-side `can()` check
// (services/api/src/patient-admin.ts, Principal-only) is the real
// boundary, not this component.
//
// Two independent forms, one component: creating an account and
// resetting a password are the same "Principal acts on a patient's
// Cognito credential" shape, and both need the identical one-time,
// never-persisted password display — building that once and reusing it
// is simpler than two near-identical files.
//
// **The find-by-email search (follow-up, same day)**: resetting a password
// needs the patient's account id, and the create form's own success panel
// was, at first, the only place one was ever surfaced. `GET /patients?email=`
// (patient-admin.ts) now answers that directly — no new DynamoDB index,
// just Cognito's own `AdminGetUser` against the pool's email-keyed
// username. Finding a patient fills the reset form's own id field, so
// staff never have to copy it by hand between the two sections.
//
// **Assigning at registration (2026-08-31).** The owner's own framing of
// this page — "when they contact via whatsapp the principal clinician
// registers them to the system and assign a clinician to him" — is one
// action to the person doing it, and was two round trips on two different
// screens. The create form now carries an optional clinician dropdown
// (`GET /clinicians`); choosing one makes the panel follow a successful
// `POST /patients` with `POST /patients/{id}/approve`, the same call the
// dashboard's own assign button makes. Deliberately still *two* API
// calls, not a new combined endpoint: account creation and account
// approval are two distinct RBAC rows with two distinct audit trails
// (patient-admin.ts's own header, "two distinct actions on two distinct
// RBAC rows"), and that stays true whether or not one screen triggers
// both. Leaving the dropdown blank keeps the old behaviour exactly — the
// patient is created `pending` and waits on the dashboard.
//
// The account is reported as created either way. If the follow-up
// assignment fails, the password panel still appears — the account exists
// and its one-time password must not be swallowed by an error about a
// later step — with a plain note that the assignment did not happen and
// can be made from the dashboard.
import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { buildCreatePatientRequestBody } from './patient-admin-request.js';
import type { CreatePatientFormFields, CreatePatientRequestBody } from './patient-admin-request.js';

type CreateStatus = 'idle' | 'submitting' | 'success' | 'conflict' | 'invalid' | 'forbidden' | 'error';
type ResetStatus = 'idle' | 'submitting' | 'success' | 'notFound' | 'forbidden' | 'error';
type FindStatus = 'idle' | 'submitting' | 'success' | 'notFound' | 'forbidden' | 'error';

interface FoundPatient {
  readonly id: string;
  readonly fullName: string;
  readonly accountStatus: string;
}

/** One assignable colleague, from `GET /clinicians`. Deactivated ones never reach the dropdown. */
interface AssignableClinician {
  readonly id: string;
  readonly displayName: string;
}

/**
 * What the create panel reports. `assignedTo` names the colleague the
 * follow-up approval actually assigned; `assignmentFailed` says the
 * principal chose one and the approval call did not land — two different
 * facts from "no clinician was chosen", which is both fields absent.
 */
interface CreateResult {
  readonly id: string;
  readonly password: string;
  readonly assignedTo?: string;
  readonly assignmentFailed?: boolean;
}

const EMPTY_CREATE_FIELDS: CreatePatientFormFields = {
  email: '',
  fullName: '',
  phone: '',
  marketingOptIn: false,
  referralSource: '',
  presentingCondition: '',
};

export interface PatientAdminPanelStrings {
  readonly forbidden: string;
  readonly createHeading: string;
  readonly createIntro: string;
  readonly emailLabel: string;
  readonly fullNameLabel: string;
  readonly phoneLabel: string;
  readonly marketingOptInLabel: string;
  readonly referralSourceLabel: string;
  readonly presentingConditionLabel: string;
  readonly createButton: string;
  readonly creating: string;
  readonly createSuccessHeading: string;
  readonly createSuccessWarning: string;
  readonly passwordLabel: string;
  readonly patientIdLabel: string;
  readonly createConflictError: string;
  readonly createValidationError: string;
  readonly createError: string;
  readonly assignClinicianLabel: string;
  readonly assignClinicianNone: string;
  readonly assignClinicianHint: string;
  readonly assignedToLabel: string;
  readonly assignFailedWarning: string;
  readonly findHeading: string;
  readonly findIntro: string;
  readonly findButton: string;
  readonly finding: string;
  readonly findNotFoundError: string;
  readonly findError: string;
  readonly foundPatientLabel: string;
  readonly foundStatusLabel: string;
  readonly useIdButton: string;
  readonly resetHeading: string;
  readonly resetIntro: string;
  readonly patientIdInputLabel: string;
  readonly resetButton: string;
  readonly resetting: string;
  readonly resetSuccessHeading: string;
  readonly resetSuccessWarning: string;
  readonly resetNotFoundError: string;
  readonly resetError: string;
}

export interface PatientAdminPanelProps {
  readonly strings: PatientAdminPanelStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly createPatient?: (accessToken: string, body: CreatePatientRequestBody) => Promise<Response>;
  readonly resetPassword?: (accessToken: string, patientId: string) => Promise<Response>;
  readonly findPatient?: (accessToken: string, email: string) => Promise<Response>;
  readonly listClinicians?: (accessToken: string) => Promise<Response>;
  readonly approvePatient?: (
    accessToken: string,
    patientId: string,
    clinicianId: string,
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

function defaultCreatePatient(
  accessToken: string,
  body: CreatePatientRequestBody,
): Promise<Response> {
  return fetch(`${contentApiUrl}/patients`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function defaultResetPassword(accessToken: string, patientId: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}/reset-password`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultFindPatient(accessToken: string, email: string): Promise<Response> {
  const url = new URL(`${contentApiUrl}/patients`);
  url.searchParams.set('email', email);
  return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
}

function defaultListClinicians(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/clinicians`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultApprovePatient(
  accessToken: string,
  patientId: string,
  clinicianId: string,
): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/${encodeURIComponent(patientId)}/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ assignedClinicianId: clinicianId }),
  });
}

/** A password, shown once, in a plain readonly field — easy to select-all and copy, no clipboard-API permission to fail on. */
function OneTimePassword({
  password,
  passwordLabel,
}: {
  readonly password: string;
  readonly passwordLabel: string;
}): ReactNode {
  return (
    <p>
      <label htmlFor="one-time-password">{passwordLabel}</label>{' '}
      <input id="one-time-password" type="text" readOnly value={password} onFocus={(event) => event.currentTarget.select()} />
    </p>
  );
}

export function PatientAdminPanel({
  strings,
  client = defaultClient,
  createPatient = defaultCreatePatient,
  resetPassword = defaultResetPassword,
  findPatient = defaultFindPatient,
  listClinicians = defaultListClinicians,
  approvePatient = defaultApprovePatient,
}: PatientAdminPanelProps): ReactNode {
  const [createFields, setCreateFields] = useState<CreatePatientFormFields>(EMPTY_CREATE_FIELDS);
  const [createStatus, setCreateStatus] = useState<CreateStatus>('idle');
  const [createResult, setCreateResult] = useState<CreateResult | undefined>();

  const [clinicians, setClinicians] = useState<readonly AssignableClinician[]>([]);
  const [assignClinicianId, setAssignClinicianId] = useState('');

  const [findEmailInput, setFindEmailInput] = useState('');
  const [findStatus, setFindStatus] = useState<FindStatus>('idle');
  const [foundPatient, setFoundPatient] = useState<FoundPatient | undefined>();

  const [patientIdInput, setPatientIdInput] = useState('');
  const [resetStatus, setResetStatus] = useState<ResetStatus>('idle');
  const [resetPasswordResult, setResetPasswordResult] = useState<string | undefined>();

  // Loaded once on mount. A failure leaves the list empty, which renders
  // the form without its optional dropdown — registering a patient must
  // not depend on the clinician directory being reachable.
  useEffect(() => {
    let cancelled = false;
    const loadClinicians = async () => {
      const accessToken = await client.authorization();
      if (!accessToken) {
        return;
      }
      try {
        const response = await listClinicians(accessToken);
        if (!response.ok) {
          return;
        }
        const payload = (await response.json()) as {
          items?: readonly { id: string; displayName: string; account_status: string }[];
        };
        if (cancelled) {
          return;
        }
        setClinicians(
          (payload.items ?? [])
            .filter((clinician) => clinician.account_status === 'active')
            .map(({ id, displayName }) => ({ id, displayName })),
        );
      } catch {
        // Left empty — see this effect's own note.
      }
    };
    void loadClinicians();
    return () => {
      cancelled = true;
    };
  }, [client, listClinicians]);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCreateStatus('submitting');
    setCreateResult(undefined);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setCreateStatus('forbidden');
      return;
    }
    try {
      const response = await createPatient(accessToken, buildCreatePatientRequestBody(createFields));
      if (response.status === 403 || response.status === 401) {
        setCreateStatus('forbidden');
        return;
      }
      if (response.status === 409) {
        setCreateStatus('conflict');
        return;
      }
      if (response.status === 400) {
        setCreateStatus('invalid');
        return;
      }
      if (!response.ok) {
        setCreateStatus('error');
        return;
      }
      const payload = (await response.json()) as { item?: { id?: string }; password?: string };
      if (!payload.item?.id || !payload.password) {
        setCreateStatus('error');
        return;
      }
      const patientId = payload.item.id;
      // The optional second step. Its failure never downgrades the create:
      // the account exists and its password is shown once, here, or not at
      // all — see this file's 2026-08-31 header note.
      let assignedTo: string | undefined;
      let assignmentFailed = false;
      if (assignClinicianId) {
        try {
          const approval = await approvePatient(accessToken, patientId, assignClinicianId);
          if (approval.ok) {
            assignedTo = clinicians.find((c) => c.id === assignClinicianId)?.displayName;
          } else {
            assignmentFailed = true;
          }
        } catch {
          assignmentFailed = true;
        }
      }
      setCreateResult({
        id: patientId,
        password: payload.password,
        ...(assignedTo ? { assignedTo } : {}),
        ...(assignmentFailed ? { assignmentFailed } : {}),
      });
      setCreateFields(EMPTY_CREATE_FIELDS);
      setAssignClinicianId('');
      setCreateStatus('success');
    } catch {
      setCreateStatus('error');
    }
  };

  const handleFind = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = findEmailInput.trim();
    if (!email) {
      return;
    }
    setFindStatus('submitting');
    setFoundPatient(undefined);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setFindStatus('forbidden');
      return;
    }
    try {
      const response = await findPatient(accessToken, email);
      if (response.status === 403 || response.status === 401) {
        setFindStatus('forbidden');
        return;
      }
      if (response.status === 404) {
        setFindStatus('notFound');
        return;
      }
      if (!response.ok) {
        setFindStatus('error');
        return;
      }
      const payload = (await response.json()) as {
        item?: { id?: string; personal?: { fullName?: string }; account_status?: string };
      };
      if (!payload.item?.id) {
        setFindStatus('error');
        return;
      }
      setFoundPatient({
        id: payload.item.id,
        fullName: payload.item.personal?.fullName ?? '',
        accountStatus: payload.item.account_status ?? '',
      });
      setFindStatus('success');
    } catch {
      setFindStatus('error');
    }
  };

  const handleReset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const patientId = patientIdInput.trim();
    if (!patientId) {
      return;
    }
    setResetStatus('submitting');
    setResetPasswordResult(undefined);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setResetStatus('forbidden');
      return;
    }
    try {
      const response = await resetPassword(accessToken, patientId);
      if (response.status === 403 || response.status === 401) {
        setResetStatus('forbidden');
        return;
      }
      if (response.status === 404) {
        setResetStatus('notFound');
        return;
      }
      if (!response.ok) {
        setResetStatus('error');
        return;
      }
      const payload = (await response.json()) as { password?: string };
      if (!payload.password) {
        setResetStatus('error');
        return;
      }
      setResetPasswordResult(payload.password);
      setResetStatus('success');
    } catch {
      setResetStatus('error');
    }
  };

  const isCreating = createStatus === 'submitting';
  const isFinding = findStatus === 'submitting';
  const isResetting = resetStatus === 'submitting';

  return (
    <>
      <section>
        <h2>{strings.createHeading}</h2>
        <p>{strings.createIntro}</p>
        <form onSubmit={(event) => void handleCreate(event)}>
          <p>
            <label htmlFor="create-email">{strings.emailLabel}</label>
            <input
              id="create-email"
              type="email"
              required
              disabled={isCreating}
              value={createFields.email}
              onChange={(event) => setCreateFields((f) => ({ ...f, email: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="create-full-name">{strings.fullNameLabel}</label>
            <input
              id="create-full-name"
              type="text"
              required
              disabled={isCreating}
              value={createFields.fullName}
              onChange={(event) => setCreateFields((f) => ({ ...f, fullName: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="create-phone">{strings.phoneLabel}</label>
            <input
              id="create-phone"
              type="tel"
              disabled={isCreating}
              value={createFields.phone}
              onChange={(event) => setCreateFields((f) => ({ ...f, phone: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="create-referral-source">{strings.referralSourceLabel}</label>
            <input
              id="create-referral-source"
              type="text"
              disabled={isCreating}
              value={createFields.referralSource}
              onChange={(event) => setCreateFields((f) => ({ ...f, referralSource: event.target.value }))}
            />
          </p>
          <p>
            <label htmlFor="create-presenting-condition">{strings.presentingConditionLabel}</label>
            <input
              id="create-presenting-condition"
              type="text"
              disabled={isCreating}
              value={createFields.presentingCondition}
              onChange={(event) =>
                setCreateFields((f) => ({ ...f, presentingCondition: event.target.value }))
              }
            />
          </p>
          {clinicians.length > 0 && (
            <>
              <p>
                <label htmlFor="create-assign-clinician">{strings.assignClinicianLabel}</label>
                <select
                  id="create-assign-clinician"
                  disabled={isCreating}
                  aria-describedby="create-assign-clinician-hint"
                  value={assignClinicianId}
                  onChange={(event) => setAssignClinicianId(event.target.value)}
                >
                  <option value="">{strings.assignClinicianNone}</option>
                  {clinicians.map((clinician) => (
                    <option key={clinician.id} value={clinician.id}>
                      {clinician.displayName}
                    </option>
                  ))}
                </select>
              </p>
              <p id="create-assign-clinician-hint">{strings.assignClinicianHint}</p>
            </>
          )}
          <p>
            <label htmlFor="create-marketing-opt-in">
              <input
                id="create-marketing-opt-in"
                type="checkbox"
                disabled={isCreating}
                checked={createFields.marketingOptIn}
                onChange={(event) =>
                  setCreateFields((f) => ({ ...f, marketingOptIn: event.target.checked }))
                }
              />{' '}
              {strings.marketingOptInLabel}
            </label>
          </p>
          {createStatus === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
          {createStatus === 'conflict' && <p role="alert">{strings.createConflictError}</p>}
          {createStatus === 'invalid' && <p role="alert">{strings.createValidationError}</p>}
          {createStatus === 'error' && <p role="alert">{strings.createError}</p>}
          <button type="submit" disabled={isCreating}>
            {isCreating ? strings.creating : strings.createButton}
          </button>
        </form>
        {createStatus === 'success' && createResult && (
          <div role="alert">
            <h3>{strings.createSuccessHeading}</h3>
            <p>{strings.createSuccessWarning}</p>
            <OneTimePassword password={createResult.password} passwordLabel={strings.passwordLabel} />
            <p>
              {strings.patientIdLabel}: <code>{createResult.id}</code>
            </p>
            {createResult.assignedTo && (
              <p>
                {strings.assignedToLabel}: {createResult.assignedTo}
              </p>
            )}
            {createResult.assignmentFailed && <p>{strings.assignFailedWarning}</p>}
          </div>
        )}
      </section>

      <section>
        <h2>{strings.findHeading}</h2>
        <p>{strings.findIntro}</p>
        <form onSubmit={(event) => void handleFind(event)}>
          <p>
            <label htmlFor="find-email">{strings.emailLabel}</label>
            <input
              id="find-email"
              type="email"
              required
              disabled={isFinding}
              value={findEmailInput}
              onChange={(event) => setFindEmailInput(event.target.value)}
            />
          </p>
          {findStatus === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
          {findStatus === 'notFound' && <p role="alert">{strings.findNotFoundError}</p>}
          {findStatus === 'error' && <p role="alert">{strings.findError}</p>}
          <button type="submit" disabled={isFinding}>
            {isFinding ? strings.finding : strings.findButton}
          </button>
        </form>
        {findStatus === 'success' && foundPatient && (
          <div role="status">
            <p>
              {strings.foundPatientLabel}: {foundPatient.fullName} (<code>{foundPatient.id}</code>)
            </p>
            <p>
              {strings.foundStatusLabel}: {foundPatient.accountStatus}
            </p>
            <button type="button" onClick={() => setPatientIdInput(foundPatient.id)}>
              {strings.useIdButton}
            </button>
          </div>
        )}
      </section>

      <section>
        <h2>{strings.resetHeading}</h2>
        <p>{strings.resetIntro}</p>
        <form onSubmit={(event) => void handleReset(event)}>
          <p>
            <label htmlFor="reset-patient-id">{strings.patientIdInputLabel}</label>
            <input
              id="reset-patient-id"
              type="text"
              required
              disabled={isResetting}
              value={patientIdInput}
              onChange={(event) => setPatientIdInput(event.target.value)}
            />
          </p>
          {resetStatus === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
          {resetStatus === 'notFound' && <p role="alert">{strings.resetNotFoundError}</p>}
          {resetStatus === 'error' && <p role="alert">{strings.resetError}</p>}
          <button type="submit" disabled={isResetting}>
            {isResetting ? strings.resetting : strings.resetButton}
          </button>
        </form>
        {resetStatus === 'success' && resetPasswordResult && (
          <div role="alert">
            <h3>{strings.resetSuccessHeading}</h3>
            <p>{strings.resetSuccessWarning}</p>
            <OneTimePassword password={resetPasswordResult} passwordLabel={strings.passwordLabel} />
          </div>
        )}
      </section>
    </>
  );
}
