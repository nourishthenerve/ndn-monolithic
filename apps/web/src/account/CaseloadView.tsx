// TASK 2.5.3 step 6: the principal clinician's cross-caseload view.
// Rendered only inside `RequireAuth` (caseload.astro), so this component
// never mounts before a session exists — but it still treats a `403` from
// the API as an ordinary, expected outcome rather than an error: a
// signed-in sub-clinician or patient can reach this *page* (RequireAuth
// only knows "signed in", not role), and the server-side `can()` check
// (services/api/src/caseload.ts) is the real boundary. This component's
// job is to say so plainly, not to guess at roles client-side.
//
// One page of results in state at a time — never every page accumulated,
// matching the backend's own "never accumulate a caseload in memory"
// (step 5) at the UI layer too. Previous pages are recoverable via a
// client-side cursor stack, not by holding their data.
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { SessionClient } from '../auth/session.js';
import { createSessionClient } from '../auth/session.js';
import { contentApiUrl } from '../site-config.js';

export interface CaseloadEntry {
  readonly patientId: string;
  readonly fullName: string;
  readonly assignedClinicianName: string;
}

interface CaseloadPage {
  readonly items: readonly CaseloadEntry[];
  readonly nextCursor?: string;
}

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'forbidden' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly page: CaseloadPage };

export interface CaseloadViewStrings {
  readonly loadingLabel: string;
  readonly forbiddenLabel: string;
  readonly errorLabel: string;
  readonly emptyLabel: string;
  readonly patientColumnLabel: string;
  readonly clinicianColumnLabel: string;
  readonly nextPageLabel: string;
  readonly previousPageLabel: string;
  readonly caption: string;
}

export interface CaseloadViewProps {
  readonly strings: CaseloadViewStrings;
  readonly client?: SessionClient;
  /** Injectable for tests; defaults to a real same-origin-authorised fetch against `contentApiUrl`. */
  readonly fetchPage?: (cursor: string | undefined, accessToken: string) => Promise<Response>;
}

const defaultClient = createSessionClient();

function defaultFetchPage(cursor: string | undefined, accessToken: string): Promise<Response> {
  const url = new URL(`${contentApiUrl}/caseload`);
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }
  return fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
}

export function CaseloadView({
  strings,
  client = defaultClient,
  fetchPage = defaultFetchPage,
}: CaseloadViewProps): ReactNode {
  const [state, setState] = useState<ViewState>({ status: 'loading' });
  // The cursor that produced the page currently on screen, and the stack
  // of cursors that got here — popping it is how "previous page" works
  // without ever holding more than one page's data.
  const [cursorStack, setCursorStack] = useState<readonly (string | undefined)[]>([undefined]);

  const load = useCallback(
    async (cursor: string | undefined) => {
      setState({ status: 'loading' });
      const accessToken = await client.authorization();
      if (!accessToken) {
        // RequireAuth already guarantees a session exists to get this far,
        // but a token can still expire mid-visit — treated the same as a
        // real 401 would be: `forbidden` is closer than `error` when the
        // real answer is "sign in again", but this component has no
        // sign-in control of its own, so it says the plain, honest thing.
        setState({ status: 'forbidden' });
        return;
      }
      try {
        const response = await fetchPage(cursor, accessToken);
        if (response.status === 403 || response.status === 401) {
          setState({ status: 'forbidden' });
          return;
        }
        if (!response.ok) {
          setState({ status: 'error' });
          return;
        }
        const payload = (await response.json()) as Partial<CaseloadPage>;
        setState({
          status: 'ready',
          page: { items: payload.items ?? [], nextCursor: payload.nextCursor },
        });
      } catch {
        setState({ status: 'error' });
      }
    },
    [client, fetchPage],
  );

  useEffect(() => {
    void load(cursorStack.at(-1));
  }, [cursorStack, load]);

  const goNext = (nextCursor: string) => {
    setCursorStack((stack) => [...stack, nextCursor]);
  };
  const goPrevious = () => {
    setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack));
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

  if (state.page.items.length === 0 && cursorStack.length === 1) {
    return <p>{strings.emptyLabel}</p>;
  }

  return (
    <>
      <table>
        <caption>{strings.caption}</caption>
        <thead>
          <tr>
            <th scope="col">{strings.patientColumnLabel}</th>
            <th scope="col">{strings.clinicianColumnLabel}</th>
          </tr>
        </thead>
        <tbody>
          {state.page.items.map((item) => (
            <tr key={item.patientId}>
              <td>{item.fullName}</td>
              <td>{item.assignedClinicianName}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <nav aria-label={strings.caption}>
        <button type="button" onClick={goPrevious} disabled={cursorStack.length <= 1}>
          {strings.previousPageLabel}
        </button>
        <button
          type="button"
          onClick={() => state.page.nextCursor && goNext(state.page.nextCursor)}
          disabled={!state.page.nextCursor}
        >
          {strings.nextPageLabel}
        </button>
      </nav>
    </>
  );
}
