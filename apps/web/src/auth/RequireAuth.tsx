// TASK 2.2.4 step 6: nothing protected reaches the DOM before the session
// resolves.
//
// The page itself stays statically generated and empty — ADR-0017's
// static-output decision is intact, because what makes this page private
// is not server rendering but the fact that its content does not exist in
// the HTML at all. Astro ships an empty shell; this island decides whether
// to build anything, and while it is deciding it renders `null`.
//
// "Renders nothing" is literal. Not `hidden`, not `display: none`, not
// opacity — a protected fragment that is in the DOM and merely invisible
// is a protected fragment anyone can read with a devtools panel or a
// screen reader that ignores the styling.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { createSessionClient, type SessionClient, type SessionState } from './session.js';

export interface RequireAuthProps {
  readonly children: ReactNode;
  /** Rendered in place of the children when there is no session — a sign-in prompt, never the content. */
  readonly signedOut: ReactNode;
  /** Announced while the session resolves. */
  readonly loadingLabel: string;
  /** Injectable for tests; defaults to the module-level client. */
  readonly client?: SessionClient;
}

const defaultClient = createSessionClient();

export function RequireAuth({
  children,
  signedOut,
  loadingLabel,
  client = defaultClient,
}: RequireAuthProps): ReactNode {
  const [state, setState] = useState<SessionState>({ status: 'unknown' });

  useEffect(() => {
    let live = true;
    void client.resolve().then((resolved) => {
      if (live) setState(resolved);
    });
    return () => {
      live = false;
    };
  }, [client]);

  if (state.status === 'unknown') {
    // A live region rather than a bare spinner: a screen-reader user is
    // told the page is working, which is the same information a sighted
    // user gets from the text.
    return (
      <p role="status" aria-live="polite">
        {loadingLabel}
      </p>
    );
  }

  return state.status === 'signed-in' ? <>{children}</> : <>{signedOut}</>;
}
