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
import { useState } from 'react';
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
}: PatientAdminPanelProps): ReactNode {
  const [createFields, setCreateFields] = useState<CreatePatientFormFields>(EMPTY_CREATE_FIELDS);
  const [createStatus, setCreateStatus] = useState<CreateStatus>('idle');
  const [createResult, setCreateResult] = useState<{ id: string; password: string } | undefined>();

  const [findEmailInput, setFindEmailInput] = useState('');
  const [findStatus, setFindStatus] = useState<FindStatus>('idle');
  const [foundPatient, setFoundPatient] = useState<FoundPatient | undefined>();

  const [patientIdInput, setPatientIdInput] = useState('');
  const [resetStatus, setResetStatus] = useState<ResetStatus>('idle');
  const [resetPasswordResult, setResetPasswordResult] = useState<string | undefined>();

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
      setCreateResult({ id: payload.item.id, password: payload.password });
      setCreateFields(EMPTY_CREATE_FIELDS);
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
