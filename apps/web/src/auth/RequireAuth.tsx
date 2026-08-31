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
import type { StaffRole } from './token-claims.js';

export interface RequireAuthProps {
  readonly children: ReactNode;
  /**
   * Rendered in place of the children when there is no session — a
   * sign-in prompt, never the content. Optional so a *nested* gate (one
   * inside another `RequireAuth` that has already handled the signed-out
   * case) can omit it and render nothing rather than repeat the prompt.
   */
  readonly signedOut?: ReactNode;
  /**
   * Announced while the session resolves. Optional for the same reason
   * `signedOut` is: a nested gate whose parent already announced the wait
   * must not announce it a second time, and omitting this renders nothing
   * at all until the session is known — the same "renders nothing is
   * literal" discipline this file's header describes.
   */
  readonly loadingLabel?: string;
  /**
   * 2026-08-31: when set, a signed-in caller whose staff role is *known*
   * and not in this list gets `forbidden` instead of the children — so a
   * sub-clinician never sees a create-patient or create-clinician form at
   * all, rather than filling one in and being refused at submit.
   *
   * "Known" is doing real work here. `token-claims.ts` distinguishes a
   * positive answer from "could not read the token", and only a positive
   * answer hides anything: an unreadable token renders the children as
   * before and lets the server refuse, because hiding the admin pages
   * from the one person entitled to them is a far worse failure than
   * briefly offering them to someone the API will turn away. **This is
   * presentation, not authorisation** — every route behind these pages
   * re-derives the role from a verified token and checks the RBAC matrix,
   * unchanged.
   *
   * The lists are not uniform, which is why this is a list rather than a
   * boolean: the patient dashboard and patient accounts admit `helpdesk`
   * alongside the principal; clinician accounts admits the principal
   * alone. Each page's list mirrors its own routes' matrix column.
   */
  readonly allowStaffRoles?: readonly StaffRole[];
  /** Rendered in place of the children for a signed-in caller the line above excludes. Omit to render nothing at all. */
  readonly forbidden?: ReactNode;
  /** Injectable for tests; defaults to the module-level client. */
  readonly client?: SessionClient;
}

const defaultClient = createSessionClient();

export function RequireAuth({
  children,
  signedOut,
  loadingLabel,
  allowStaffRoles,
  forbidden,
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
    // user gets from the text. No label, no region — an empty live region
    // announces nothing and is worse than none.
    return loadingLabel ? (
      <p role="status" aria-live="polite">
        {loadingLabel}
      </p>
    ) : null;
  }

  if (state.status !== 'signed-in') {
    return <>{signedOut}</>;
  }

  // A known role that is not on the list hides; an unreadable token
  // deliberately falls through to the children — see `allowStaffRoles`.
  const { staffRole } = state.session;
  if (allowStaffRoles && staffRole !== undefined && !allowStaffRoles.includes(staffRole)) {
    return <>{forbidden}</>;
  }

  return <>{children}</>;
}
