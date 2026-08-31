// 2026-08-31: reading one claim off the access token the browser already
// holds, to decide **what to render** — never what to allow.
//
// ## Why this exists
//
// The owner, on finding the staff pages offered to a sub-clinician:
// *"for a non-principal clinician I dont even want create patient or
// create clinician account to be visible. Atm it says at the very end that
// you dont have permission to create the account."* That is exactly what
// the UI did: every panel treated a 403 as an ordinary outcome (correctly
// — the server is the boundary), but it only ever *found out* at submit
// time, after someone had filled in a form they were never going to be
// allowed to send. Offering an action and then refusing it is worse than
// not offering it.
//
// ## Why it is safe to read an unverified claim here
//
// This function does not verify the token's signature and must never be
// treated as if it did. It doesn't need to, because **nothing downstream
// of it is an authorisation decision**. Every route this gates —
// `POST /patients`, `POST /clinicians`, `GET /caseload`, `GET /clinicians`
// — re-derives the caller's role inside the Lambda authorizer from a
// *verified* token (`services/api/src/authorizer.ts`'s `roleFor`) and
// checks it against the RBAC matrix, exactly as before. The worst a forged
// claim buys is the sight of a link, followed by the same 403 the server
// would have returned anyway; the worst a *wrong* answer here costs is a
// hidden link on a page the user can still reach by URL.
//
// That asymmetry is why this is deliberately not a new `GET /auth/me`
// endpoint or a `role` field threaded through `/auth/token`. Both would be
// changes to the one flow the clinic has just got working, deployed to
// answer a question the browser can already answer for itself, for a
// purpose that carries no security weight.
//
// ## What it can and cannot tell apart
//
// It answers "which named staff group is this token in", not "what is
// this caller's role". Telling a patient token from a sub-clinician token
// needs the pool, and the pool is only knowable from `iss` against a
// user-pool id this bundle does not carry — so both collapse into
// `'other'`, which is exactly right for the only thing this is used for:
// every gate the UI has is "one of the named staff groups, or not".
// (`authorizer.ts` refuses a patient-pool token claiming either group;
// here, a patient pool that somehow held a same-named group would reveal
// a link and nothing else.)
//
// Extended 2026-08-31 (same day) from a boolean to `StaffRole`, when the
// helpdesk role arrived and the UI's gates stopped being uniform: the
// patient dashboard and patient accounts admit helpdesk, clinician
// accounts does not.

/** The `cognito:groups` memberships that name a staff role — `authorizer.ts`'s own constants, restated. */
const PRINCIPAL_CLINICIAN_GROUP = 'principal-clinician';
const HELPDESK_GROUP = 'helpdesk';

/**
 * `'other'` is a real, positive answer — "a readable token in neither
 * named group", i.e. a sub-clinician or a patient — and is what a caller
 * hides content on. It is *not* the same as `undefined`; see
 * `staffRoleFromAccessToken`.
 */
export type StaffRole = 'principal-clinician' | 'helpdesk' | 'other';

/** base64url → JSON, with the padding `atob` wants and the UTF-8 decode a JSON payload deserves. */
function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return undefined;
  }
  const base64url = segments[1] ?? '';
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `StaffRole` when the token says so, and **`undefined` when it cannot
 * be read at all** — the two are not the same, and the difference decides
 * behaviour: a caller that cannot tell must fall back to showing the
 * thing and letting the server refuse it, never to hiding a page from the
 * one person entitled to it because a claim moved. Hide on a positive
 * answer; never on a shrug.
 *
 * `principal-clinician` is tested before `helpdesk`, matching
 * `authorizer.ts`'s own precedence exactly — a token carrying both
 * resolves to the wider role on the server, and a UI that disagreed would
 * hide pages the API would have allowed.
 */
export function staffRoleFromAccessToken(accessToken: string): StaffRole | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) {
    return undefined;
  }
  const groups = payload['cognito:groups'];
  if (!Array.isArray(groups)) {
    // A clinician in no group at all is a sub-clinician, and Cognito omits
    // the claim entirely rather than sending an empty array — so an absent
    // claim on a readable token is a real answer, not a failure to read.
    return 'other';
  }
  if (groups.includes(PRINCIPAL_CLINICIAN_GROUP)) {
    return 'principal-clinician';
  }
  return groups.includes(HELPDESK_GROUP) ? 'helpdesk' : 'other';
}
