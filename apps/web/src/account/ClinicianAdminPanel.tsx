// D-30: the principal-facing form for `POST /clinicians` — the same
// "Principal acts on a colleague's Cognito credential" shape
// `PatientAdminPanel.tsx` already built for patients (D-29), rendered only
// inside `RequireAuth` (clinician-admin.astro), same posture: a 403 here is
// an ordinary, expected outcome — the server-side `can()` check
// (services/api/src/clinician-admin.ts, Principal-only) is the real
// boundary, not this component.
//
// ## Amendment, 2026-08-31 — the directory, and a chosen password
//
// This file's own header used to say "One form, not three: … no separate
// reset-password/deactivate/reactivate UI yet — scoped to exactly what was
// asked for, creating a colleague's account", and predicted that
// `POST /clinicians/{id}/deactivate|reactivate` "can grow their own panel
// section later without reshaping this one." That is what happened, and
// for the reason that comment anticipated: the owner asked for "an option
// to add or remove a clinicians — with which the old one will not have
// access to login and the new one will now have access after principal
// clinician has provided email and password for him." Three changes, no
// reshaping of the create form:
//
//   * a **directory** section, from `GET /clinicians` (new, same day), so
//     there is somewhere to *see* colleagues — deactivate has been live
//     since TASK 2.4.1 with no way to discover an id to call it with;
//   * **deactivate/reactivate** buttons on each row. "Remove" is
//     deactivation, never deletion: `AdminDeleteUserCommand` is a banned
//     identifier repo-wide, and deactivation is what the request actually
//     asks for — `disable` + `revokeTokens` end any live session
//     immediately, so "the old one will not have access to login" holds
//     from that moment;
//   * an **optional password** field on the create form. Left blank, the
//     API generates one exactly as before (still the recommendation —
//     longer and less guessable than a typed one). Filled in, it is used
//     verbatim, and Cognito's own policy is what judges it: a rejection
//     comes back as a 400 this form shows, never a silently weakened
//     account.
//
// The list reloads after every mutation rather than patching a row in
// state — the principal acts on this page a handful of times a year, and
// a re-read is the one way the screen cannot disagree with the record.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { buildCreateClinicianRequestBody } from './clinician-admin-request.js';
import type {
  ClinicianFormRole,
  CreateClinicianFormFields,
  CreateClinicianRequestBody,
} from './clinician-admin-request.js';

type CreateStatus =
  | 'idle'
  | 'submitting'
  | 'success'
  | 'conflict'
  | 'invalid'
  | 'weakPassword'
  | 'forbidden'
  | 'error';
type DirectoryStatus = 'loading' | 'ready' | 'forbidden' | 'error';

/** A `<select>` hands back a plain string; this is the one place it becomes a role, closed-set and defaulting to the least-privileged value. */
function asFormRole(value: string): ClinicianFormRole {
  return value === 'principal' || value === 'helpdesk' || value === 'visitor' ? value : 'sub';
}

const EMPTY_CREATE_FIELDS: CreateClinicianFormFields = {
  email: '',
  displayName: '',
  role: 'sub',
  password: '',
};

/** One row of `GET /clinicians` — the `Clinician` record's own fields, narrowed to what this panel renders. */
export interface DirectoryClinician {
  readonly id: string;
  readonly displayName: string;
  readonly role: ClinicianFormRole;
  readonly account_status: 'active' | 'deactivated';
}

export interface ClinicianAdminPanelStrings {
  readonly forbidden: string;
  readonly createHeading: string;
  readonly createIntro: string;
  readonly emailLabel: string;
  readonly displayNameLabel: string;
  readonly roleLabel: string;
  readonly rolePrincipalLabel: string;
  readonly roleSubLabel: string;
  readonly roleHelpdeskLabel: string;
  readonly roleVisitorLabel: string;
  readonly passwordFieldLabel: string;
  readonly passwordFieldHint: string;
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
  readonly createWeakPasswordError: string;
  readonly createError: string;
  readonly directoryHeading: string;
  readonly directoryIntro: string;
  readonly directoryLoading: string;
  readonly directoryError: string;
  readonly directoryEmpty: string;
  readonly nameColumnLabel: string;
  readonly roleColumnLabel: string;
  readonly statusColumnLabel: string;
  readonly actionColumnLabel: string;
  readonly statusActiveLabel: string;
  readonly statusDeactivatedLabel: string;
  readonly deactivateButton: string;
  readonly reactivateButton: string;
  readonly working: string;
  readonly deactivateConfirm: string;
  readonly actionError: string;
}

export interface ClinicianAdminPanelProps {
  readonly strings: ClinicianAdminPanelStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly createClinician?: (
    accessToken: string,
    body: CreateClinicianRequestBody,
  ) => Promise<Response>;
  readonly listClinicians?: (accessToken: string) => Promise<Response>;
  readonly setClinicianActive?: (
    accessToken: string,
    clinicianId: string,
    active: boolean,
  ) => Promise<Response>;
  /**
   * Injectable for tests; defaults to the browser's own `confirm`.
   * Deactivation ends a colleague's session the moment it lands, so it
   * asks first — the one irreversible-feeling action on this page.
   */
  readonly confirmDeactivate?: (message: string) => boolean;
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

function defaultListClinicians(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/clinicians`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultSetClinicianActive(
  accessToken: string,
  clinicianId: string,
  active: boolean,
): Promise<Response> {
  const action = active ? 'reactivate' : 'deactivate';
  return fetch(`${contentApiUrl}/clinicians/${encodeURIComponent(clinicianId)}/${action}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}` },
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
  listClinicians = defaultListClinicians,
  setClinicianActive = defaultSetClinicianActive,
  confirmDeactivate,
}: ClinicianAdminPanelProps): ReactNode {
  const [fields, setFields] = useState<CreateClinicianFormFields>(EMPTY_CREATE_FIELDS);
  const [status, setStatus] = useState<CreateStatus>('idle');
  const [result, setResult] = useState<CreateClinicianResult | undefined>();

  const [directoryStatus, setDirectoryStatus] = useState<DirectoryStatus>('loading');
  const [clinicians, setClinicians] = useState<readonly DirectoryClinician[]>([]);
  /** The id currently being deactivated/reactivated — one at a time, so only that row's button is busy. */
  const [pendingId, setPendingId] = useState<string | undefined>();
  const [actionFailed, setActionFailed] = useState(false);

  const loadDirectory = useCallback(async () => {
    setDirectoryStatus('loading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setDirectoryStatus('forbidden');
      return;
    }
    try {
      const response = await listClinicians(accessToken);
      if (response.status === 403 || response.status === 401) {
        setDirectoryStatus('forbidden');
        return;
      }
      if (!response.ok) {
        setDirectoryStatus('error');
        return;
      }
      const payload = (await response.json()) as { items?: readonly DirectoryClinician[] };
      setClinicians(payload.items ?? []);
      setDirectoryStatus('ready');
    } catch {
      setDirectoryStatus('error');
    }
  }, [client, listClinicians]);

  useEffect(() => {
    void loadDirectory();
  }, [loadDirectory]);

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
        // Two very different 400s: a malformed form, and a password
        // Cognito's own policy refused. Only the second is something the
        // principal can fix by typing a different password, so they are
        // told apart rather than sharing one message.
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setStatus(body.error === 'PASSWORD_POLICY_VIOLATION' ? 'weakPassword' : 'invalid');
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
      void loadDirectory();
    } catch {
      setStatus('error');
    }
  };

  const handleSetActive = async (clinician: DirectoryClinician, active: boolean) => {
    if (!active) {
      const confirmed = confirmDeactivate
        ? confirmDeactivate(strings.deactivateConfirm)
        : globalThis.confirm?.(strings.deactivateConfirm) !== false;
      if (!confirmed) {
        return;
      }
    }
    setActionFailed(false);
    setPendingId(clinician.id);
    const accessToken = await client.authorization();
    if (!accessToken) {
      setPendingId(undefined);
      setDirectoryStatus('forbidden');
      return;
    }
    try {
      const response = await setClinicianActive(accessToken, clinician.id, active);
      if (!response.ok) {
        setActionFailed(true);
        return;
      }
      await loadDirectory();
    } catch {
      setActionFailed(true);
    } finally {
      setPendingId(undefined);
    }
  };

  const isCreating = status === 'submitting';

  const roleLabel = (role: ClinicianFormRole): string => {
    switch (role) {
      case 'principal':
        return strings.rolePrincipalLabel;
      case 'helpdesk':
        return strings.roleHelpdeskLabel;
      case 'visitor':
        return strings.roleVisitorLabel;
      case 'sub':
        return strings.roleSubLabel;
    }
  };

  return (
    <>
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
              onChange={(event) => setFields((f) => ({ ...f, role: asFormRole(event.target.value) }))}
            >
              <option value="sub">{strings.roleSubLabel}</option>
              <option value="helpdesk">{strings.roleHelpdeskLabel}</option>
              <option value="visitor">{strings.roleVisitorLabel}</option>
              <option value="principal">{strings.rolePrincipalLabel}</option>
            </select>
          </p>
          <p>
            <label htmlFor="create-clinician-password">{strings.passwordFieldLabel}</label>
            {/* `type="text"`, not `password`: the principal is about to
                read this out over WhatsApp, and a masked field they cannot
                check is how a colleague ends up locked out of an account
                nobody can reproduce the password for. Nothing is masked on
                the success panel either, for the same reason. */}
            <input
              id="create-clinician-password"
              type="text"
              autoComplete="off"
              disabled={isCreating}
              aria-describedby="create-clinician-password-hint"
              value={fields.password}
              onChange={(event) => setFields((f) => ({ ...f, password: event.target.value }))}
            />
          </p>
          <p id="create-clinician-password-hint">{strings.passwordFieldHint}</p>
          {status === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
          {status === 'conflict' && <p role="alert">{strings.createConflictError}</p>}
          {status === 'invalid' && <p role="alert">{strings.createValidationError}</p>}
          {status === 'weakPassword' && <p role="alert">{strings.createWeakPasswordError}</p>}
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

      <section>
        <h2>{strings.directoryHeading}</h2>
        <p>{strings.directoryIntro}</p>
        {directoryStatus === 'loading' && (
          <p role="status" aria-live="polite">
            {strings.directoryLoading}
          </p>
        )}
        {directoryStatus === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
        {directoryStatus === 'error' && <p role="alert">{strings.directoryError}</p>}
        {actionFailed && <p role="alert">{strings.actionError}</p>}
        {directoryStatus === 'ready' &&
          (clinicians.length === 0 ? (
            <p>{strings.directoryEmpty}</p>
          ) : (
            <table>
              <caption>{strings.directoryHeading}</caption>
              <thead>
                <tr>
                  <th scope="col">{strings.nameColumnLabel}</th>
                  <th scope="col">{strings.roleColumnLabel}</th>
                  <th scope="col">{strings.statusColumnLabel}</th>
                  <th scope="col">{strings.actionColumnLabel}</th>
                </tr>
              </thead>
              <tbody>
                {clinicians.map((clinician) => {
                  const isActive = clinician.account_status === 'active';
                  const isBusy = pendingId === clinician.id;
                  return (
                    <tr key={clinician.id}>
                      <td>{clinician.displayName}</td>
                      <td>{roleLabel(clinician.role)}</td>
                      <td>{isActive ? strings.statusActiveLabel : strings.statusDeactivatedLabel}</td>
                      <td>
                        {/* The principal is never offered a control that
                            would lock themselves out: exactly one principal
                            exists (clinician-repository.ts's own
                            invariant), and deactivating them would leave
                            nobody who can reactivate anyone. */}
                        {clinician.role === 'principal' ? null : (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => void handleSetActive(clinician, !isActive)}
                          >
                            {isBusy
                              ? strings.working
                              : isActive
                                ? strings.deactivateButton
                                : strings.reactivateButton}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ))}
      </section>
    </>
  );
}
