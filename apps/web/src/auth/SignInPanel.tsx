// TASK 2.2.4 step 8: the signed-out state, the callback exchange and
// sign-out — the three things this site owns in the sign-in journey.
//
// **The sign-in control is an anchor, not a button with a handler.**
// `GET /auth/signin` is a 302 to the Cognito-hosted page, so signing in is
// a plain link: it works with JavaScript disabled, it is keyboard- and
// screen-reader-reachable because it is a link, and there is no click
// handler for the a11y suite to catch out. The server needs the request
// in order to set the PKCE cookie before the redirect, which is what makes
// a link the correct control rather than merely a convenient one.
//
// **Where the one-time code is entered.** On the Cognito managed-login
// page, not here — that is the consequence of the authorization-code flow
// this task's own Resolution chose, and it is stated in
// docs/runbooks/web-authentication.md rather than left to be discovered.
// What this file owns is every state around it: signed out, exchanging,
// failed, signed in.
import { Button, Link } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { createSessionClient, type SessionClient } from './session.js';

export interface SignInPanelStrings {
  readonly signInLabel: string;
  readonly signOutLabel: string;
  readonly exchangingLabel: string;
  readonly failedLabel: string;
}

export interface SignInPanelProps {
  readonly strings: SignInPanelStrings;
  readonly client?: SessionClient;
}

const defaultClient = createSessionClient();

// `pool` mirrors `auth-routes.ts`'s own `poolFrom()` convention exactly:
// anything that isn't `'clinician'` is the patient pool, so omitting the
// prop (every call site before this one) is unchanged behaviour.
export function SignInLink({
  label,
  pool,
}: {
  readonly label: string;
  readonly pool?: 'patient' | 'clinician';
}): ReactNode {
  return <Link href={pool === 'clinician' ? '/auth/signin?pool=clinician' : '/auth/signin'}>{label}</Link>;
}

export function SignOutButton({
  label,
  client = defaultClient,
}: {
  readonly label: string;
  readonly client?: SessionClient;
}): ReactNode {
  return (
    <Button
      type="button"
      onClick={() => {
        // Sign-out is a real server call: it revokes the refresh token at
        // Cognito (2.2.1 enabled revocation) rather than only dropping the
        // cookie, so a captured cookie stops working too.
        void client.signOut().then(() => {
          window.location.assign('/');
        });
      }}
    >
      {label}
    </Button>
  );
}

/**
 * The callback island. Reads `code`/`state` from the query, posts them to
 * `/auth/token`, and navigates on. It never reads a token from the URL —
 * there is none to read, which is the whole point of the code flow.
 */
export function AuthCallback({
  strings,
  destination,
  client = defaultClient,
}: SignInPanelProps & { readonly destination: string }): ReactNode {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const code = query.get('code');
    const state = query.get('state');
    if (!code || !state) {
      setFailed(true);
      return;
    }
    void client.complete(code, state).then((resolved) => {
      if (resolved.status === 'signed-in') {
        // `replace`, not `assign`: the callback URL carries a spent
        // authorization code and should not sit in history where a back
        // button re-submits it.
        window.location.replace(destination);
      } else {
        setFailed(true);
      }
    });
  }, [client, destination]);

  return failed ? (
    <p role="alert">
      {strings.failedLabel} <SignInLink label={strings.signInLabel} />
    </p>
  ) : (
    <p role="status" aria-live="polite">
      {strings.exchangingLabel}
    </p>
  );
}
