// D-30: the principal-facing form for `POST /clinicians` — the same
// "Principal acts on a colleague's Cognito credential" shape
// `PatientAdminPanel.tsx` already built for patients (D-29), rendered only
// inside `RequireAuth` (clinician-admin.astro), same posture: a 403 here is
// an ordinary, expected outcome — the server-side `can()` check
// (services/api/src/clinician-admin.ts, Principal-only) is the real
// boundary, not this component.
//
// One form, not three: unlike patient administration, there is no
// find-by-email step here (nothing downstream needs a clinician's id typed
// back in) and no separate reset-password/deactivate/reactivate UI yet —
// scoped to exactly what was asked for, creating a colleague's account.
// `POST /clinicians/{id}/deactivate|reactivate` already exist on the API
// (clinician-admin.ts) and can grow their own panel section later without
// reshaping this one.
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { buildCreateClinicianRequestBody } from './clinician-admin-request.js';
import type { CreateClinicianFormFields, CreateClinicianRequestBody } from './clinician-admin-request.js';

type CreateStatus = 'idle' | 'submitting' | 'success' | 'conflict' | 'invalid' | 'forbidden' | 'error';

const EMPTY_CREATE_FIELDS: CreateClinicianFormFields = {
  email: '',
  displayName: '',
  role: 'sub',
};

export interface ClinicianAdminPanelStrings {
  readonly forbidden: string;
  readonly createHeading: string;
  readonly createIntro: string;
  readonly emailLabel: string;
  readonly displayNameLabel: string;
  readonly roleLabel: string;
  readonly rolePrincipalLabel: string;
  readonly roleSubLabel: string;
  readonly createButton: string;
  readonly creating: string;
  readonly createSuccessHeading: string;
  readonly createSuccessWarning: string;
  readonly passwordLabel: string;
  readonly totpSecretLabel: string;
  readonly otpauthUriLabel: string;
  readonly clinicianIdLabel: string;
  readonly createConflictError: string;
  readonly createValidationError: string;
  readonly createError: string;
}

export interface ClinicianAdminPanelProps {
  readonly strings: ClinicianAdminPanelStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly createClinician?: (
    accessToken: string,
    body: CreateClinicianRequestBody,
  ) => Promise<Response>;
}

interface CreateClinicianResult {
  readonly id: string;
  readonly password: string;
  /** Absent when the pool's `mfa` is `OPTIONAL` and nothing was provisioned — see clinician-admin.ts's own header. */
  readonly totpSecret?: string;
  readonly otpauthUri?: string;
}

const defaultClient = createSessionClient();

function defaultCreateClinician(
  accessToken: string,
  body: CreateClinicianRequestBody,
): Promise<Response> {
  return fetch(`${contentApiUrl}/clinicians`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A secret, shown once, in a plain readonly field — easy to select-all and copy, no clipboard-API permission to fail on. */
function OneTimeSecret({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  const id = `one-time-secret-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <p>
      <label htmlFor={id}>{label}</label>{' '}
      <input id={id} type="text" readOnly value={value} onFocus={(event) => event.currentTarget.select()} />
    </p>
  );
}

export function ClinicianAdminPanel({
  strings,
  client = defaultClient,
  createClinician = defaultCreateClinician,
}: ClinicianAdminPanelProps): ReactNode {
  const [fields, setFields] = useState<CreateClinicianFormFields>(EMPTY_CREATE_FIELDS);
  const [status, setStatus] = useState<CreateStatus>('idle');
  const [result, setResult] = useState<CreateClinicianResult | undefined>();

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus('submitting');
    setResult(undefined);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setStatus('forbidden');
      return;
    }
    try {
      const response = await createClinician(accessToken, buildCreateClinicianRequestBody(fields));
      if (response.status === 403 || response.status === 401) {
        setStatus('forbidden');
        return;
      }
      if (response.status === 409) {
        setStatus('conflict');
        return;
      }
      if (response.status === 400) {
        setStatus('invalid');
        return;
      }
      if (!response.ok) {
        setStatus('error');
        return;
      }
      const payload = (await response.json()) as {
        item?: { id?: string };
        password?: string;
        totpSecret?: string;
        otpauthUri?: string;
      };
      if (!payload.item?.id || !payload.password) {
        setStatus('error');
        return;
      }
      setResult({
        id: payload.item.id,
        password: payload.password,
        totpSecret: payload.totpSecret,
        otpauthUri: payload.otpauthUri,
      });
      setFields(EMPTY_CREATE_FIELDS);
      setStatus('success');
    } catch {
      setStatus('error');
    }
  };

  const isCreating = status === 'submitting';

  return (
    <section>
      <h2>{strings.createHeading}</h2>
      <p>{strings.createIntro}</p>
      <form onSubmit={(event) => void handleCreate(event)}>
        <p>
          <label htmlFor="create-clinician-email">{strings.emailLabel}</label>
          <input
            id="create-clinician-email"
            type="email"
            required
            disabled={isCreating}
            value={fields.email}
            onChange={(event) => setFields((f) => ({ ...f, email: event.target.value }))}
          />
        </p>
        <p>
          <label htmlFor="create-clinician-display-name">{strings.displayNameLabel}</label>
          <input
            id="create-clinician-display-name"
            type="text"
            required
            disabled={isCreating}
            value={fields.displayName}
            onChange={(event) => setFields((f) => ({ ...f, displayName: event.target.value }))}
          />
        </p>
        <p>
          <label htmlFor="create-clinician-role">{strings.roleLabel}</label>
          <select
            id="create-clinician-role"
            disabled={isCreating}
            value={fields.role}
            onChange={(event) =>
              setFields((f) => ({ ...f, role: event.target.value === 'principal' ? 'principal' : 'sub' }))
            }
          >
            <option value="sub">{strings.roleSubLabel}</option>
            <option value="principal">{strings.rolePrincipalLabel}</option>
          </select>
        </p>
        {status === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
        {status === 'conflict' && <p role="alert">{strings.createConflictError}</p>}
        {status === 'invalid' && <p role="alert">{strings.createValidationError}</p>}
        {status === 'error' && <p role="alert">{strings.createError}</p>}
        <button type="submit" disabled={isCreating}>
          {isCreating ? strings.creating : strings.createButton}
        </button>
      </form>
      {status === 'success' && result && (
        <div role="alert">
          <h3>{strings.createSuccessHeading}</h3>
          <p>{strings.createSuccessWarning}</p>
          <OneTimeSecret label={strings.passwordLabel} value={result.password} />
          {result.totpSecret && result.otpauthUri && (
            <>
              <OneTimeSecret label={strings.totpSecretLabel} value={result.totpSecret} />
              <OneTimeSecret label={strings.otpauthUriLabel} value={result.otpauthUri} />
            </>
          )}
          <p>
            {strings.clinicianIdLabel}: <code>{result.id}</code>
          </p>
        </div>
      )}
    </section>
  );
}
