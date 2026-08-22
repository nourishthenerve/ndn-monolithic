// TASK 3.6.2 step 1: the read/compose surface for TASK 3.6.1's now
// genuinely bidirectional messaging. Same posture as
// `AssignedContent.tsx`/`ClinicalRecordTimeline.tsx`: rendered only
// inside `RequireAuth`, so a `403` here is an ordinary, expected outcome
// (the server-side `can()` check in `message.ts` is the real boundary),
// not an error.
//
// This task's own title says "on both sides of the account shell," but
// its own Files/Steps/Interfaces name exactly one new component and one
// new page, no patient-id selector, and no caseload-integration route —
// there is no mechanism named anywhere in this task for a clinician to
// pick which patient's thread to view. Built here as the patient's own
// account page, consuming `/patients/me/messages` (the identical `/me`
// resolution every other patient-scoped account page in this phase
// already uses) — "both sides" read as both directions of the
// conversation (read *and* compose) on the patient's own page, not a
// second UI this task doesn't otherwise specify. A clinician-facing
// per-patient thread view is a real, honestly-named gap — see this
// task's own runbook section.
//
// Step 2: no real-time transport. A sent message is appended to local
// state immediately (so the sender sees their own message without a
// round trip), but nothing else refreshes the thread — the same "static
// page, island decides what to fetch" posture every other Phase 2/3 page
// takes.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export interface MessageEntry {
  readonly senderRole: 'patient' | 'sub-clinician' | 'principal-clinician';
  readonly body: string;
  readonly created_at: string;
}

type ThreadState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly items: readonly MessageEntry[] };

type ComposeState = 'idle' | 'sending' | 'rateLimited' | 'error';

export interface MessageThreadStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly composePlaceholder: string;
  readonly sendLabel: string;
  readonly sendingLabel: string;
  readonly sendErrorLabel: string;
  readonly rateLimitedLabel: string;
}

export interface MessageThreadProps {
  readonly strings: MessageThreadStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchThread?: (accessToken: string) => Promise<Response>;
  readonly sendMessage?: (accessToken: string, body: string) => Promise<Response>;
}

const defaultClient = createSessionClient();

// `/patients/me/messages` — this component has no way to know its own
// patient id, so the server resolves `me` from the verified principal
// instead (`message.ts`).
function defaultFetchThread(accessToken: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/messages`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

function defaultSendMessage(accessToken: string, body: string): Promise<Response> {
  return fetch(`${contentApiUrl}/patients/me/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
}

export function MessageThread({
  strings,
  client = defaultClient,
  fetchThread = defaultFetchThread,
  sendMessage = defaultSendMessage,
}: MessageThreadProps): ReactNode {
  const [thread, setThread] = useState<ThreadState>({ status: 'loading' });
  const [composeValue, setComposeValue] = useState('');
  const [composeState, setComposeState] = useState<ComposeState>('idle');

  const load = useCallback(async () => {
    setThread({ status: 'loading' });
    const accessToken = await client.authorization();
    if (!accessToken) {
      setThread({ status: 'forbidden' });
      return;
    }
    try {
      const response = await fetchThread(accessToken);
      if (response.status === 403 || response.status === 401) {
        setThread({ status: 'forbidden' });
        return;
      }
      if (!response.ok) {
        setThread({ status: 'error' });
        return;
      }
      const payload = (await response.json()) as { items?: readonly MessageEntry[] };
      setThread({ status: 'ready', items: payload.items ?? [] });
    } catch {
      setThread({ status: 'error' });
    }
  }, [client, fetchThread]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSend = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = composeValue.trim();
    if (!body || thread.status !== 'ready') {
      return;
    }
    setComposeState('sending');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setThread({ status: 'forbidden' });
      return;
    }
    try {
      const response = await sendMessage(accessToken, body);
      if (response.status === 403 || response.status === 401) {
        setThread({ status: 'forbidden' });
        return;
      }
      if (response.status === 429) {
        setComposeState('rateLimited');
        return;
      }
      if (!response.ok) {
        setComposeState('error');
        return;
      }
      const payload = (await response.json()) as { item?: MessageEntry };
      if (payload.item) {
        setThread({ status: 'ready', items: [...thread.items, payload.item] });
      }
      setComposeValue('');
      setComposeState('idle');
    } catch {
      setComposeState('error');
    }
  };

  if (thread.status === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loadingLabel}
      </p>
    );
  }
  if (thread.status === 'forbidden') {
    return <p role="alert">{strings.forbiddenLabel}</p>;
  }
  if (thread.status === 'error') {
    return <p role="alert">{strings.errorLabel}</p>;
  }

  const isSending = composeState === 'sending';

  return (
    <section>
      {thread.items.length === 0 ? (
        <p>{strings.emptyLabel}</p>
      ) : (
        <ol>
          {thread.items.map((item, index) => (
            // `created_at` alone can collide (message-repository.ts's own
            // disambiguating sort-key suffix exists precisely because two
            // messages can share a millisecond) and the domain object
            // carries no separate id, so the index disambiguates within
            // one render of a list this component never reorders.
            <li key={`${item.created_at}-${index}`}>
              <p>{item.body}</p>
            </li>
          ))}
        </ol>
      )}
      <form onSubmit={(event) => void handleSend(event)}>
        <p>
          <label htmlFor="message-compose">{strings.composePlaceholder}</label>
          <textarea
            id="message-compose"
            value={composeValue}
            onChange={(event) => setComposeValue(event.target.value)}
            placeholder={strings.composePlaceholder}
            required
            disabled={isSending}
          />
        </p>
        {composeState === 'rateLimited' && <p role="alert">{strings.rateLimitedLabel}</p>}
        {composeState === 'error' && <p role="alert">{strings.sendErrorLabel}</p>}
        <button type="submit" disabled={isSending}>
          {isSending ? strings.sendingLabel : strings.sendLabel}
        </button>
      </form>
    </section>
  );
}
