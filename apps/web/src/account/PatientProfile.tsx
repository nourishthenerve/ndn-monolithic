// TASK 3.1.1 step 5: the patient's own profile, read and edited from the
// account shell TASK 2.2.4 built with nothing behind it. Rendered only
// inside `RequireAuth`, so this component never mounts before a session
// exists — but it still treats a `403` from the API as an ordinary,
// expected outcome, not an error, the same posture `CaseloadView.tsx`
// (TASK 2.5.3) takes for the identical reason: the page only knows
// "signed in", never role, and the server-side `can()` check
// (services/api/src/patient.ts) is the real boundary.
//
// Only `personal{}` is editable here — `fullName`, `phone`,
// `marketingOptIn` — never `email` (bound to the signed-in identity) and
// never `clinical{}` (a clinician's own patch, not built into this page).
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export interface PatientProfileData {
  readonly personal: {
    readonly fullName: string;
    readonly email: string;
    readonly phone?: string;
    readonly marketingOptIn: boolean;
  };
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly profile: PatientProfileData }
  | { readonly status: 'saving'; readonly profile: PatientProfileData }
  | { readonly status: 'saved'; readonly profile: PatientProfileData };

export interface PatientProfileStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly savedLabel: string;
  readonly fullNameLabel: string;
  readonly emailLabel: string;
  readonly phoneLabel: string;
  readonly marketingOptInLabel: string;
  readonly saveLabel: string;
  readonly savingLabel: string;
}

export interface PatientProfileProps {
  readonly strings: PatientProfileStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchProfile?: (accessToken: string) => Promise<Response>;
  readonly savePatch?: (
    accessToken: string,
    patch: { readonly personal: Record<string, unknown> },
  ) => Promise<Response>;
}

const defaultClient = createSessionClient();

// `/patients/me` (services/api/src/patient.ts) rather than a real id: this
// component has no way to know its own patient id — `SessionClient` never
// decodes the access token's claims, deliberately, per session.ts's own
// header — so the server resolves "me" from the verified principal
// instead of the browser needing to.
function defaultFetchProfile(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultSavePatch(
  accessToken: string,
  patch: { readonly personal: Record<string, unknown> },
): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me`, {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(patch),
  });
}

export function PatientProfile({
  strings,
  client = defaultClient,
  fetchProfile = defaultFetchProfile,
  savePatch = defaultSavePatch,
}: PatientProfileProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [marketingOptIn, setMarketingOptIn] = useState(false);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await fetchProfile(accessToken);
      if (response.status === 403 || response.status === 401) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { item?: PatientProfileData };
      if (!payload.item) {
        setState({ status: 'error' });
        return;
      }
      setFullName(payload.item.personal.fullName);
      setPhone(payload.item.personal.phone ?? '');
      setMarketingOptIn(payload.item.personal.marketingOptIn);
      setState({ status: 'ready', profile: payload.item });
    } catch {
      setState({ status: 'error' });
    }
  }, [client, fetchProfile]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.status !== 'ready' && state.status !== 'saved') {
      return;
    }
    setState({ status: 'saving', profile: state.profile });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState({ status: 'forbidden' });
      return;
    }
    try {
      const response = await savePatch(accessToken, {
        personal: { fullName, phone: phone || undefined, marketingOptIn },
      });
      if (response.status === 403 || response.status === 401) {
        setState({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setState({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { item?: PatientProfileData };
      if (!payload.item) {
        setState({ status: 'error' });
        return;
      }
      setState({ status: 'saved', profile: payload.item });
    } catch {
      setState({ status: 'error' });
    }
  };

  if (state.status === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (state.status === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (state.status === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const isSaving = state.status === 'saving';

  return (
    <form onSubmit={(event) => void handleSubmit(event)}>
      {state.status === 'saved' && (
        <p role="status" aria-live="polite">
          {strings.savedLabel}
        </p>
      )}
      <p>
        <label htmlFor="patient-email">{strings.emailLabel}</label>
        <input id="patient-email" type="email" value={state.profile.personal.email} disabled readOnly />
      </p>
      <p>
        <label htmlFor="patient-full-name">{strings.fullNameLabel}</label>
        <input
          id="patient-full-name"
          type="text"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          required
          disabled={isSaving}
        />
      </p>
      <p>
        <label htmlFor="patient-phone">{strings.phoneLabel}</label>
        <input
          id="patient-phone"
          type="tel"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          disabled={isSaving}
        />
      </p>
      <p>
        <label htmlFor="patient-marketing-opt-in">
          <input
            id="patient-marketing-opt-in"
            type="checkbox"
            checked={marketingOptIn}
            onChange={(event) => setMarketingOptIn(event.target.checked)}
            disabled={isSaving}
          />
          {strings.marketingOptInLabel}
        </label>
      </p>
      <button type="submit" disabled={isSaving}>
        {isSaving ? strings.savingLabel : strings.saveLabel}
      </button>
    </form>
  );
}
