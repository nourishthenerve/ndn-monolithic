// 2026-08-31: a clinician editing their own record — the owner's *"other
// clinician would be able to update his details"*.
//
// `Own profile` has been a row in docs/plan/04-data-model-rbac.md since
// TASK 2.1.1, granting `R U` to every signed-in column, with **no
// endpoint and no UI behind it**. `GET`/`PATCH /clinicians/me` is the
// endpoint; this is the UI.
//
// It sits on the change-password page rather than getting one of its own.
// Both are "the account you are signed in as, acted on by yourself", and
// a person who wants to correct their name and a person who wants to
// change their password are looking in the same place — a second route
// would be a second thing to find and a second thing to link.
//
// Rendered for clinicians only (the page decides, `allowRoles`), because
// `displayName` is a field on the `CLI#` record and a patient has none —
// their equivalent is `/account/patient`, which edits the fields a
// patient actually has.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

type PanelState = 'loading' | 'ready' | 'saving' | 'saved' | 'forbidden' | 'error';

export interface OwnDetailsPanelStrings {
  readonly heading: string;
  readonly intro: string;
  readonly displayNameLabel: string;
  readonly saveButton: string;
  readonly saving: string;
  readonly savedMessage: string;
  readonly loading: string;
  readonly forbidden: string;
  readonly error: string;
}

export interface OwnDetailsPanelProps {
  readonly strings: OwnDetailsPanelStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchOwnDetails?: (accessToken: string) => Promise<Response>;
  readonly saveOwnDetails?: (accessToken: string, displayName: string) => Promise<Response>;
}

const defaultClient = createSessionClient();

function defaultFetchOwnDetails(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/clinicians/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultSaveOwnDetails(accessToken: string, displayName: string): Promise<Response> {
  return fetch(`${contentApiUrl}/clinicians/me`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ displayName }),
  });
}

export function OwnDetailsPanel({
  strings,
  client = defaultClient,
  fetchOwnDetails = defaultFetchOwnDetails,
  saveOwnDetails = defaultSaveOwnDetails,
}: OwnDetailsPanelProps): ReactNode {
  const [state, setState] = useState<PanelState>('loading');
  const [displayName, setDisplayName] = useState('');

  const load = useCallback(async () => {
    setState('loading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    try {
      const response = await fetchOwnDetails(accessToken);
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      const payload = (await response.json()) as { item?: { displayName?: string } };
      setDisplayName(payload.item?.displayName ?? '');
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchOwnDetails]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = displayName.trim();
    if (!trimmed) {
      return;
    }
    setState('saving');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    try {
      const response = await saveOwnDetails(accessToken, trimmed);
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      // The trimmed value is what the server stored, so it is what the
      // field should show afterwards — not the untrimmed text the person
      // happened to type.
      setDisplayName(trimmed);
      setState('saved');
    } catch {
      setState('error');
    }
  };

  if (state === 'loading') {
    return (
      <section>
        <h2>{strings.heading}</h2>
        <p role="status" aria-live="polite">
          {strings.loading}
        </p>
      </section>
    );
  }
  if (state === 'forbidden') {
    return (
      <section>
        <h2>{strings.heading}</h2>
        <p role="alert">{strings.forbidden}</p>
      </section>
    );
  }

  const isSaving = state === 'saving';

  return (
    <section>
      <h2>{strings.heading}</h2>
      <p>{strings.intro}</p>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <p>
          <label htmlFor="own-display-name">{strings.displayNameLabel}</label>
          <input
            id="own-display-name"
            type="text"
            required
            disabled={isSaving}
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
              // Editing after a save clears the confirmation — leaving
              // "Saved." beside changed, unsaved text is a lie.
              setState((current) => (current === 'saved' ? 'ready' : current));
            }}
          />
        </p>
        {state === 'error' && <p role="alert">{strings.error}</p>}
        {state === 'saved' && <p role="status">{strings.savedMessage}</p>}
        <button type="submit" disabled={isSaving || displayName.trim().length === 0}>
          {isSaving ? strings.saving : strings.saveButton}
        </button>
      </form>
    </section>
  );
}
