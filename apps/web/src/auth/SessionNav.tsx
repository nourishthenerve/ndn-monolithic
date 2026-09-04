// 2026-09-02: what the site's primary nav offers depends on whether
// anyone is signed in. Until now it did not, and that was a real bug
// rather than an untidiness.
//
// ## What went wrong
//
// `Nav.astro` rendered "Patient sign in" and "Clinician sign in" on every
// page, unconditionally — it is a static Astro component and had no
// notion of a session at all. The owner, signed in with principal
// clinician credentials, clicked "Patient sign in" and **landed on a test
// patient's details**.
//
// Nothing was authorised that should not have been: what happened is that
// Cognito's own hosted-UI session cookie for the patient pool was still
// live from an earlier sign-in, so the redirect came straight back with a
// code and `/auth/token` exchanged it. The browser genuinely held that
// patient's session by the end of it. `session.ts`'s own `signOut` doc
// already names this mechanism for the other pool — "the *next* sign-in
// would silently re-authenticate against it (found live, 2026-08-31)" —
// and an always-visible sign-in link is what made it reachable at any
// moment, from any page, by one click.
//
// So the fix is not a permission: it is that **a signed-in person is
// never offered a way to silently become someone else**, and is offered
// the thing they actually need instead.
//
// ## Why `client:only`, when that costs the no-JS case
//
// Rendering nothing until the session resolves is the point — a
// server-rendered fallback of "here are two sign-in links" would flash
// exactly the control this exists to withhold, and a fast click during
// that flash lands in the same place as before.
//
// The usual objection is that a visitor with no JavaScript then has no
// way to sign in. Here that costs nothing real: every authenticated page
// in this site is a `client:only` island behind `RequireAuth`, so a
// browser that cannot run them cannot use the account area whether or not
// it can reach the sign-in link. The link would be an entrance to a room
// that is not there.
//
// ## 2026-09-04: this is now the *only* sign-out control on the site
//
// The owner: *"there are sign out button almost on all page. remove them.
// just keep it at top right for both patients and clinicians/principal."*
//
// Every account page rendered its own `<SignOutButton>` at the bottom —
// thirteen of them, each a copy of the same line, because every page in
// the account shell was built from the one before it and TASK 2.2.4's
// original page had nowhere else to put one. Once the site nav learned
// about sessions (above), that stopped being the only place it could live
// and started being twelve extra places to keep in step: two controls for
// one action, one of them below the fold on a long form, and a second
// tab stop on every page for a screen-reader user to pass on the way out.
//
// It lives here, in the header, where a signed-in person already looks for
// it and where it is the same control on every page — patient, clinician
// and principal alike, since this island reads only "is there a session"
// and never a role. `account-sign-out.test.ts` keeps the account pages
// from quietly growing their own again.
import { Link } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { createSessionClient, type SessionClient } from './session.js';
import { SignInLink, SignOutButton } from './SignInPanel.js';

export interface SessionNavStrings {
  readonly patientSignIn: string;
  readonly clinicianSignIn: string;
  readonly account: string;
  readonly signOut: string;
}

export interface SessionNavProps {
  readonly strings: SessionNavStrings;
  /** Locale-prefixed account path — the one destination a signed-in visitor is offered here. */
  readonly accountHref: string;
  /**
   * Class for the `<ul>` this renders, so the nav can style it like its
   * own list. The list is rendered *here* rather than in `Nav.astro`
   * because Astro wraps a `client:only` island in an `<astro-island>`
   * element: nested inside the site-nav `<ul>` that is a direct child a
   * list may not have, and axe's `list` rule (serious, WCAG 1.3.1) failed
   * every public page on it at once.
   */
  readonly listClassName?: string;
  readonly client?: SessionClient;
}

const defaultClient = createSessionClient();

export function SessionNav({
  strings,
  accountHref,
  listClassName,
  client = defaultClient,
}: SessionNavProps): ReactNode {
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
        // A session that cannot be resolved is not a session. Falling back
        // to the signed-out controls is the safe direction: the worst case
        // is offering sign-in to someone who is already signed in, which
        // is what `RequireAuth` would also do, rather than hiding sign-out
        // from someone who needs it.
        if (!cancelled) {
          setStatus('signed-out');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  // Nothing at all while resolving — see this file's header. Not a
  // placeholder, not the signed-out links: either would be a control that
  // is wrong for half the visitors who see it.
  if (status === 'resolving') {
    return null;
  }

  if (status === 'signed-in') {
    return (
      <ul className={listClassName}>
        <li>
          <Link href={accountHref}>{strings.account}</Link>
        </li>
        <li>
          <SignOutButton label={strings.signOut} client={client} />
        </li>
      </ul>
    );
  }

  return (
    <ul className={listClassName}>
      <li>
        <SignInLink label={strings.patientSignIn} pool="patient" />
      </li>
      <li>
        <SignInLink label={strings.clinicianSignIn} pool="clinician" />
      </li>
    </ul>
  );
}
