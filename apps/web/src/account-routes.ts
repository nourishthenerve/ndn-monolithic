// TASK 5.3.1: `routes.ts`'s own registry deliberately excludes every
// authenticated account-shell page — each one's own header says so
// explicitly ("Deliberately absent from routes.ts... an authenticated-
// only page has no accessible content to find that way [when scanned
// unauthenticated]"). This is that registry's counterpart: the single
// source `tests/pr-env/a11y-authenticated.test.ts` reads to know which
// authenticated pages to sign in and axe-scan for real. A page added
// under `apps/web/src/pages/[locale]/account/` that forgets to register
// itself here silently drops out of that gate, the same guarantee
// `routes.ts`'s own DoD already gives public pages.
//
// `account/callback.astro` is deliberately not registered. Unlike every
// other page here, nobody signed in ever navigates to it on purpose — it
// exists for the seconds between Cognito's redirect and `/auth/token`
// completing the exchange, and visiting it directly with no `?code=`
// leaves it in a state no real session ever produces. It has no lasting
// content a signed-in session would ever see rendered, the same reasoning
// `routes.ts` already applies to excluding `blog/[slug]`/`workshops/
// [slug]` from its own fixed list — a page whose real state can't be
// reached by just registering a static path.
import { supportedLocales } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';

/**
 * Which test identity's own content this page is built to show. Every
 * page here is still *reachable* by the other role — `CaseloadView.tsx`,
 * `AssignedContent.tsx` and every sibling account component treat a
 * `403` as an ordinary, expected outcome, not an error, because the real
 * boundary is the server-side `can()` check, never the page itself. A
 * route's `ownerRole` says whose *content* actually renders there, not
 * who is allowed to load it — the a11y suite scans every route with
 * whichever identities it has, and a page loaded by the "wrong" role
 * still gets a real axe scan of its own legible forbidden state.
 */
export type AccountOwnerRole = 'patient' | 'clinician' | 'either';

export interface AccountRouteEntry {
  readonly locale: Locale;
  /** Absolute path including the locale prefix, e.g. `/en/account/caseload`. */
  readonly path: string;
  readonly ownerRole: AccountOwnerRole;
  /**
   * Only `call.astro`: its real content needs `?appointmentId=<id>` for a
   * live, in-window appointment, not only a signed-in session — see this
   * task's own runbook for why no such fixture exists yet.
   */
  readonly needsAppointmentId?: boolean;
}

interface AccountRouteSegment {
  /** Relative to `/account`; '' means `/account` itself. No leading or trailing slash. */
  readonly segment: string;
  readonly ownerRole: AccountOwnerRole;
  readonly needsAppointmentId?: boolean;
}

const accountRouteSegments: readonly AccountRouteSegment[] = [
  // TASK 2.2.4: the first page behind a session — no role-specific
  // content of its own, just the sign-in/out shell every identity lands
  // on.
  { segment: '', ownerRole: 'either' },
  // TASK 3.1.1/3.2.1/3.2.2/3.3.1/3.3.2: the patient's own profile,
  // diagnosis, care plan and assessment timeline.
  { segment: 'patient', ownerRole: 'patient' },
  // TASK 2.5.3: the principal clinician's cross-caseload view.
  { segment: 'caseload', ownerRole: 'clinician' },
  // TASK 3.5.2: the patient's own assigned-content list.
  { segment: 'content', ownerRole: 'patient' },
  // TASK 3.6.2: both parties read and compose on the same page.
  { segment: 'messages', ownerRole: 'either' },
  // TASK 4.3.1/4.5.1: both parties join the same call from the same page.
  { segment: 'call', ownerRole: 'either', needsAppointmentId: true },
];

export const accountRoutes: readonly AccountRouteEntry[] = supportedLocales.flatMap((locale) =>
  accountRouteSegments.map(({ segment, ownerRole, needsAppointmentId }): AccountRouteEntry => ({
    locale,
    path: segment === '' ? `/${locale}/account` : `/${locale}/account/${segment}`,
    ownerRole,
    needsAppointmentId,
  })),
);
