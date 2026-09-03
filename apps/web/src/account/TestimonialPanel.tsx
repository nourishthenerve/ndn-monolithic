// 2026-09-02: a patient's own testimonial, from their own account.
//
// The owner: *"for patients, when logged in, should have option to upload
// maximum one testimonial with option to update it."*
//
// ## One record, so one form
//
// There is no list, no "new testimonial" button and no id anywhere in this
// component, because there is only ever one. The form loads whatever the
// patient has written and saves over it; the API's own path
// (`PUT /testimonials/mine`) has no id either. "Maximum one" is not
// enforced here — it is the only shape available, which is why nothing
// here has to check for it.
//
// The distinction the UI does have to carry is **published or withdrawn**,
// because those look identical in a form and could not be more different
// on the public page. A withdrawn testimonial keeps its text, so the form
// still shows the patient their own words; what changes is that saving is
// labelled as publishing again rather than updating.
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

type Display = 'full' | 'firstNameOnly' | 'anonymous';

export interface TestimonialRecord {
  readonly quote: Readonly<Record<string, string>>;
  readonly attribution: { readonly display: Display; readonly name?: string };
  readonly status: string;
}

type ViewState = 'loading' | 'ready' | 'forbidden' | 'unavailable' | 'error';
type SaveState = 'idle' | 'saving' | 'saved' | 'withdrawn' | 'invalid' | 'failed';

export interface TestimonialPanelStrings {
  readonly heading: string;
  readonly intro: string;
  readonly loading: string;
  readonly forbidden: string;
  /**
   * 2026-09-03: distinct from `error`, because a 404 here is not a failure
   * — it is `testimonials.enabled` being off, which the flag reader
   * answers by failing closed. Found the hard way: the flag had never been
   * created under its new name after the 2026-09-02 rename, and every
   * patient saw "your testimonial could not be loaded. Please try again."
   * — advice that was wrong (retrying could not help) about a cause it did
   * not name.
   */
  readonly unavailable: string;
  readonly error: string;
  readonly quoteLabel: string;
  readonly displayLabel: string;
  readonly displayFull: string;
  readonly displayFirstNameOnly: string;
  readonly displayAnonymous: string;
  readonly nameLabel: string;
  readonly nameRequired: string;
  readonly consentNotice: string;
  readonly publishButton: string;
  readonly updateButton: string;
  readonly saving: string;
  readonly savedMessage: string;
  readonly withdrawButton: string;
  readonly withdrawnMessage: string;
  readonly withdrawnNotice: string;
  readonly saveFailed: string;
}

export interface TestimonialPanelProps {
  readonly strings: TestimonialPanelStrings;
  readonly client?: SessionClient;
  readonly fetchMine?: (accessToken: string) => Promise<Response>;
  readonly save?: (accessToken: string, body: unknown) => Promise<Response>;
  readonly withdraw?: (accessToken: string) => Promise<Response>;
  readonly locale?: string;
}

const defaultClient = createSessionClient();

const MINE_URL = `${contentApiUrl}/testimonials/mine`;

function authorised(accessToken: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${accessToken}`,
    },
  };
}

export function TestimonialPanel({
  strings,
  client = defaultClient,
  fetchMine,
  save,
  withdraw,
  locale = 'en',
}: TestimonialPanelProps): ReactNode {
  const [state, setState] = useState<ViewState>('loading');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [quote, setQuote] = useState('');
  const [display, setDisplay] = useState<Display>('firstNameOnly');
  const [name, setName] = useState('');
  const [status, setStatus] = useState<string | undefined>();

  const load = useCallback(async () => {
    setState('loading');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setState('forbidden');
      return;
    }
    const request =
      fetchMine ?? ((token: string) => fetch(MINE_URL, authorised(token)));
    try {
      const response = await request(accessToken);
      // A clinician reaching this page gets the matrix's ordinary refusal.
      // The panel is not rendered for them, but the server is the boundary
      // and this is what it says.
      if (response.status === 401 || response.status === 403) {
        setState('forbidden');
        return;
      }
      // 404 is the flag being off, not a fault — see `unavailable` above.
      // Every route in this API answers a disabled feature that way.
      if (response.status === 404) {
        setState('unavailable');
        return;
      }
      if (!response.ok) {
        setState('error');
        return;
      }
      const payload = (await response.json()) as { item?: TestimonialRecord | null };
      const item = payload.item ?? undefined;
      if (item) {
        setQuote(item.quote[locale] ?? Object.values(item.quote)[0] ?? '');
        setDisplay(item.attribution.display);
        setName(item.attribution.name ?? '');
        setStatus(item.status);
      }
      setState('ready');
    } catch {
      setState('error');
    }
  }, [client, fetchMine, locale]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Checked here as well as server-side: "how should we credit you" is
    // the one question with an answer the form itself can be wrong about,
    // and "invalid body" would not tell them which field.
    if (display !== 'anonymous' && !name.trim()) {
      setSaveState('invalid');
      return;
    }
    setSaveState('saving');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setSaveState('failed');
      return;
    }
    const body = {
      quote: quote.trim(),
      attribution:
        display === 'anonymous'
          ? { display }
          : { display, name: name.trim() },
    };
    const request =
      save ??
      ((token: string, payload: unknown) =>
        fetch(
          MINE_URL,
          authorised(token, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }),
        ));
    try {
      const response = await request(accessToken, body);
      if (!response.ok) {
        setSaveState(response.status === 400 ? 'invalid' : 'failed');
        return;
      }
      setStatus('published');
      setSaveState('saved');
    } catch {
      setSaveState('failed');
    }
  };

  const handleWithdraw = async () => {
    setSaveState('saving');
    const accessToken = await client.authorization();
    if (!accessToken) {
      setSaveState('failed');
      return;
    }
    const request =
      withdraw ??
      ((token: string) => fetch(MINE_URL, authorised(token, { method: 'DELETE' })));
    try {
      const response = await request(accessToken);
      if (!response.ok) {
        setSaveState('failed');
        return;
      }
      setStatus('withdrawn');
      setSaveState('withdrawn');
    } catch {
      setSaveState('failed');
    }
  };

  if (state === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loading}
      </p>
    );
  }
  if (state === 'forbidden') {
    return <p role="alert">{strings.forbidden}</p>;
  }
  if (state === 'unavailable') {
    // `role="status"`, not `alert`: nothing has gone wrong, the feature is
    // simply not switched on.
    return <p role="status">{strings.unavailable}</p>;
  }
  if (state === 'error') {
    return <p role="alert">{strings.error}</p>;
  }

  const busy = saveState === 'saving';
  const isPublished = status === 'published';

  return (
    <section aria-labelledby="testimonial-panel-heading">
      <h2 id="testimonial-panel-heading">{strings.heading}</h2>
      <p>{strings.intro}</p>
      {status === 'withdrawn' && <p role="status">{strings.withdrawnNotice}</p>}

      <form onSubmit={(event) => void handleSubmit(event)}>
        <p>
          <label htmlFor="testimonial-quote">{strings.quoteLabel}</label>
          <textarea
            id="testimonial-quote"
            required
            rows={8}
            maxLength={2000}
            disabled={busy}
            value={quote}
            onChange={(event) => setQuote(event.target.value)}
          />
        </p>
        <p>
          <label htmlFor="testimonial-display">{strings.displayLabel}</label>
          <select
            id="testimonial-display"
            disabled={busy}
            value={display}
            onChange={(event) => setDisplay(event.target.value as Display)}
          >
            <option value="full">{strings.displayFull}</option>
            <option value="firstNameOnly">{strings.displayFirstNameOnly}</option>
            <option value="anonymous">{strings.displayAnonymous}</option>
          </select>
        </p>
        {/* Hidden rather than disabled when anonymous: there is nothing to
            type, and a greyed-out box still reads as a question being
            asked. */}
        {display !== 'anonymous' && (
          <p>
            <label htmlFor="testimonial-name">{strings.nameLabel}</label>
            <input
              id="testimonial-name"
              type="text"
              maxLength={200}
              disabled={busy}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </p>
        )}
        <p>{strings.consentNotice}</p>

        {saveState === 'invalid' && <p role="alert">{strings.nameRequired}</p>}
        {saveState === 'failed' && <p role="alert">{strings.saveFailed}</p>}
        {saveState === 'saved' && <p role="status">{strings.savedMessage}</p>}
        {saveState === 'withdrawn' && <p role="status">{strings.withdrawnMessage}</p>}

        <button type="submit" disabled={busy}>
          {busy ? strings.saving : isPublished ? strings.updateButton : strings.publishButton}
        </button>
      </form>

      {/* Only offered for something actually on the public page. Withdrawing
          what is already withdrawn is not a state anyone needs. */}
      {isPublished && (
        <p>
          <button type="button" disabled={busy} onClick={() => void handleWithdraw()}>
            {strings.withdrawButton}
          </button>
        </p>
      )}
    </section>
  );
}
