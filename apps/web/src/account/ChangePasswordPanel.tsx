// D-34 (2026-08-31): the first self-service credential action any
// clinician gets — every prior one (D-29/D-30) was staff/principal-issued
// only. Rendered only inside `RequireAuth` (change-password.astro), same
// posture as every sibling account panel: a 403 here is an ordinary,
// expected outcome — the server-side role check
// (services/api/src/clinician-admin.ts, clinician-only) is the real
// boundary, not this component. A patient who reaches this page sees the
// identical form and an identical 403 on submit; nothing about D-29's
// "no self-service for patients" is enforced client-side.
import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

import { validateChangePasswordFields } from './change-password-request.js';
import type { ChangePasswordFormFields, ChangePasswordRequestBody } from './change-password-request.js';

type Status =
  | 'idle'
  | 'submitting'
  | 'success'
  | 'mismatch'
  | 'forbidden'
  | 'incorrectCurrent'
  | 'policyViolation'
  | 'error';

const EMPTY_FIELDS: ChangePasswordFormFields = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

export interface ChangePasswordPanelStrings {
  readonly heading: string;
  readonly intro: string;
  readonly currentPasswordLabel: string;
  readonly newPasswordLabel: string;
  readonly confirmPasswordLabel: string;
  readonly submitButton: string;
  readonly submitting: string;
  readonly successMessage: string;
  readonly mismatchError: string;
  readonly forbidden: string;
  readonly incorrectCurrentPasswordError: string;
  readonly policyViolationError: string;
  readonly error: string;
}

export interface ChangePasswordPanelProps {
  readonly strings: ChangePasswordPanelStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly changePassword?: (
    accessToken: string,
    body: ChangePasswordRequestBody,
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

function defaultChangePassword(
  accessToken: string,
  body: ChangePasswordRequestBody,
): Promise<Response> {
  return fetch(`${contentApiUrl}/clinicians/me/change-password`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function ChangePasswordPanel({
  strings,
  client = defaultClient,
  changePassword = defaultChangePassword,
}: ChangePasswordPanelProps): ReactNode {
  const [fields, setFields] = useState<ChangePasswordFormFields>(EMPTY_FIELDS);
  const [status, setStatus] = useState<Status>('idle');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateChangePasswordFields(fields);
    if (!validation.valid) {
      setStatus(validation.reason === 'mismatch' ? 'mismatch' : 'error');
      return;
    }
    setStatus('submitting');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setStatus('forbidden');
      return;
    }
    try {
      const response = await changePassword(accessToken, validation.body);
      if (response.status === 403 || response.status === 401) {
        setStatus('forbidden');
        return;
      }
      if (response.status === 400) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        setStatus(
          payload.error === 'INCORRECT_CURRENT_PASSWORD' ? 'incorrectCurrent' : 'policyViolation',
        );
        return;
      }
      if (!response.ok) {
        setStatus('error');
        return;
      }
      setFields(EMPTY_FIELDS);
      setStatus('success');
    } catch {
      setStatus('error');
    }
  };

  const isSubmitting = status === 'submitting';

  return (
    <section>
      <h2>{strings.heading}</h2>
      <p>{strings.intro}</p>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <p>
          <label htmlFor="change-password-current">{strings.currentPasswordLabel}</label>
          <input
            id="change-password-current"
            type="password"
            autoComplete="current-password"
            required
            disabled={isSubmitting}
            value={fields.currentPassword}
            onChange={(event) => setFields((f) => ({ ...f, currentPassword: event.target.value }))}
          />
        </p>
        <p>
          <label htmlFor="change-password-new">{strings.newPasswordLabel}</label>
          <input
            id="change-password-new"
            type="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            value={fields.newPassword}
            onChange={(event) => setFields((f) => ({ ...f, newPassword: event.target.value }))}
          />
        </p>
        <p>
          <label htmlFor="change-password-confirm">{strings.confirmPasswordLabel}</label>
          <input
            id="change-password-confirm"
            type="password"
            autoComplete="new-password"
            required
            disabled={isSubmitting}
            value={fields.confirmPassword}
            onChange={(event) => setFields((f) => ({ ...f, confirmPassword: event.target.value }))}
          />
        </p>
        {status === 'mismatch' && <p role="alert">{strings.mismatchError}</p>}
        {status === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
        {status === 'incorrectCurrent' && <p role="alert">{strings.incorrectCurrentPasswordError}</p>}
        {status === 'policyViolation' && <p role="alert">{strings.policyViolationError}</p>}
        {status === 'error' && <p role="alert">{strings.error}</p>}
        {status === 'success' && <p role="status">{strings.successMessage}</p>}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? strings.submitting : strings.submitButton}
        </button>
      </form>
    </section>
  );
}
