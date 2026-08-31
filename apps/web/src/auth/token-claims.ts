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
// ## Why "is the principal" and not "what is the role"
//
// Telling a patient token from a sub-clinician token needs the pool, and
// the pool is only knowable from `iss` against a user-pool id this bundle
// does not carry. Every gate the UI actually has is "principal, or not",
// so that is the only question this file answers — rather than inventing a
// three-way role it cannot honestly determine. (`authorizer.ts` refuses a
// patient-pool token claiming this group; here, a patient pool that
// somehow held a same-named group would reveal a link and nothing else.)

/** The `cognito:groups` membership that distinguishes the two clinician roles — `authorizer.ts`'s own constant, restated. */
const PRINCIPAL_CLINICIAN_GROUP = 'principal-clinician';

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
 * `true` / `false` when the token says so, and **`undefined` when it
 * cannot be read at all** — three states, not two, and the difference
 * decides behaviour: a caller that cannot tell must fall back to showing
 * the thing and letting the server refuse it, never to hiding a page from
 * the one person entitled to it because a claim moved. Hide on a positive
 * "no"; never on a shrug.
 */
export function isPrincipalClinician(accessToken: string): boolean | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) {
    return undefined;
  }
  const groups = payload['cognito:groups'];
  if (!Array.isArray(groups)) {
    // A clinician in no group at all is a sub-clinician, and Cognito omits
    // the claim entirely rather than sending an empty array — so an absent
    // claim on a readable token is a real "no", not a failure to read.
    return false;
  }
  return groups.includes(PRINCIPAL_CLINICIAN_GROUP);
}
