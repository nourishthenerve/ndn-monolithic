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
// ## It mirrors `authorizer.ts`'s own `roleFor`, deliberately
//
// Pool first, then group — the identical two steps, reading the identical
// two group names, producing the identical four role values. That
// symmetry is the point: a client that derived roles its own way would
// drift from the server's, and every drift shows up as a page offered and
// then refused, or hidden from someone entitled to it.
//
// The pool comes from the token's `iss` against `site-config.ts`'s two
// issuer constants. An `iss` matching neither is `undefined` — "cannot
// tell" — not a guess.
//
// Grew twice on 2026-08-31: from a boolean, to a staff-group answer when
// helpdesk arrived, to this when the owner asked for a patient to be able
// to edit their own details. That last one is what forced patient-vs-
// clinician to be a real distinction rather than one lumped `'other'`:
// "Your details" belongs to a patient and would 404 for anyone else.

import { clinicianUserPoolIssuer, patientUserPoolIssuer } from '../site-config.js';

/** The `cognito:groups` memberships that name a staff role — `authorizer.ts`'s own constants, restated. */
const PRINCIPAL_CLINICIAN_GROUP = 'principal-clinician';
const HELPDESK_GROUP = 'helpdesk';
const VISITOR_GROUP = 'visitor';

/**
 * The same five values `Role` (@ndn/shared-types) carries, derived the
 * same way `authorizer.ts` derives them. Every one is a positive answer a
 * caller may hide content on; `undefined` — a token that cannot be read,
 * or one from neither known pool — is not, and must fall through to
 * showing the content. See `viewerRoleFromAccessToken`.
 */
export type ViewerRole =
  | 'patient'
  | 'sub-clinician'
  | 'principal-clinician'
  | 'helpdesk'
  | 'visitor';

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
 * A `ViewerRole` when the token says so, and **`undefined` when it cannot
 * be read at all** — the two are not the same, and the difference decides
 * behaviour: a caller that cannot tell must fall back to showing the
 * thing and letting the server refuse it, never to hiding a page from the
 * one person entitled to it because a claim moved. Hide on a positive
 * answer; never on a shrug.
 *
 * The pool decides first and absolutely: a patient-pool token is a
 * patient whatever its groups claim says, which is `authorizer.ts`'s own
 * rule and the reason the two pools exist. Then the groups, **widest
 * first**, matching that file's precedence exactly — a token carrying
 * several resolves to the widest role on the server, and a UI that
 * disagreed would hide pages the API allows.
 */
export function viewerRoleFromAccessToken(accessToken: string): ViewerRole | undefined {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) {
    return undefined;
  }
  const issuer = payload.iss;
  if (issuer === patientUserPoolIssuer) {
    return 'patient';
  }
  if (issuer !== clinicianUserPoolIssuer) {
    // Neither known pool — a token this bundle has no business
    // interpreting. "Cannot tell", so every caller shows its content and
    // lets the server answer.
    return undefined;
  }
  const groups = payload['cognito:groups'];
  if (!Array.isArray(groups)) {
    // A clinician in no group at all is a sub-clinician, and Cognito omits
    // the claim entirely rather than sending an empty array — so an absent
    // claim on a clinician-pool token is a real answer, not a failure to
    // read.
    return 'sub-clinician';
  }
  if (groups.includes(PRINCIPAL_CLINICIAN_GROUP)) {
    return 'principal-clinician';
  }
  if (groups.includes(HELPDESK_GROUP)) {
    return 'helpdesk';
  }
  return groups.includes(VISITOR_GROUP) ? 'visitor' : 'sub-clinician';
}
