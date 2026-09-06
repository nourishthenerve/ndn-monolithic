// 2026-09-06: the clinician pool's sign-in link, in the footer.
//
// ## Why it exists at all
//
// The site header now offers exactly one sign-in control — the patient one
// (`SessionNav.tsx`'s own header explains the redesign). Clinicians,
// helpdesk and the principal cannot use it: ADR-0004's Gate-G1 amendment
// puts them in a *different* Cognito user pool, because Cognito's MFA policy
// is pool-wide and staff must carry TOTP while patients must not. Two pools
// mean two hosted login pages, and `?pool=clinician` is the only way to
// reach the second one. Deleting this link would lock every staff member out
// of the system.
//
// ## Why it is an island rather than a plain `<a>` in Footer.astro
//
// For exactly the reason `SessionNav` is one. On 2026-09-02 an
// unconditional sign-in link let the owner — already signed in as the
// principal clinician — click through to the *other* pool and land on a test
// patient's details, because Cognito's own hosted-UI cookie for that pool
// was still live and re-authenticated silently. That hazard is symmetric:
// this link points at the clinician pool, and anyone who has signed into it
// recently has a live Cognito cookie for it too.
//
// So the rule that came out of that day holds here as well — **a signed-in
// person is never offered a way to silently become someone else**. This
// renders nothing at all while the session resolves, and nothing when there
// is one. A visitor who is not signed in is the only one who sees it, which
// is also the only one it is for.
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { createSessionClient, type SessionClient } from './session.js';
import { SignInLink } from './SignInPanel.js';

export interface StaffSignInLinkProps {
  readonly label: string;
  readonly client?: SessionClient;
}

const defaultClient = createSessionClient();

export function StaffSignInLink({
  label,
  client = defaultClient,
}: StaffSignInLinkProps): ReactNode {
  const [status, setStatus] = useState<'resolving' | 'signed-in' | 'signed-out'>('resolving');

  useEffect(() => {
    let cancelled = false;
    void client
      .resolve()
      .then((state) => {
        if (!cancelled) {
          setStatus(state.status === 'signed-in' ? 'signed-in' : 'signed-out');
        }
      })
      .catch(() => {
        // A session that cannot be resolved is not a session — the same
        // fallback direction `SessionNav` takes, and for the same reason:
        // offering sign-in to someone already signed in is a smaller harm
        // than hiding it from someone who needs it. `RequireAuth` and the
        // Lambda authorizer are the real boundary either way.
        if (!cancelled) {
          setStatus('signed-out');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (status !== 'signed-out') {
    return null;
  }

  return <SignInLink label={label} pool="clinician" />;
}
