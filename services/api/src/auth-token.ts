// TASK 2.2.4: the token exchange, and the reason it happens on a Lambda
// rather than in the browser.
//
// D-08 and ADR-0017 put this site on S3 + CloudFront with no server
// runtime, which collides with the only good place to keep a refresh
// token. There is no origin server to set an `HttpOnly` cookie, so the
// obvious paths — `localStorage`, `sessionStorage` — leave a long-lived
// credential to a patient's clinical record readable by any script that
// reaches the page. The strict CSP (1.2.3) mitigates that and does not
// remove it, and it is not an acceptable trade on this data.
//
// So: the browser never touches a refresh token. It gets an authorization
// code, posts it to `/auth/token` on its own origin, and this code does
// the PKCE exchange and answers with `Set-Cookie: HttpOnly; Secure;
// SameSite=Lax`. The access token goes back in the *body*, is held in a
// closure for its hour, and is never written anywhere.
//
// **The PKCE verifier is a cookie too, and that is the point.** The
// standard browser flow keeps the verifier in `sessionStorage`, which is
// exactly the storage this task forbids — and a full-page redirect to
// Cognito destroys any in-memory alternative. Generating it here, parking
// it in a short-lived `HttpOnly` cookie and reading it back at exchange
// time keeps every secret in this flow out of script's reach, not merely
// most of them.
import { createHash, randomBytes } from 'node:crypto';

/** Cookie names. Prefixed, so nothing else on the apex can be mistaken for one of ours. */
export const REFRESH_COOKIE = 'ndn_refresh';
export const PKCE_COOKIE = 'ndn_pkce';
export const STATE_COOKIE = 'ndn_state';

/**
 * 2026-09-02: **the only cookie here script is allowed to read, and it
 * carries nothing.** Its entire content is `1`; its entire meaning is "a
 * session may exist, so it is worth asking."
 *
 * It exists because of what `HttpOnly` costs on the read side. The refresh
 * cookie is unreadable by script — which is the whole design and is not
 * changing — so a browser cannot tell "signed out" from "signed in" without
 * a round trip to `/auth/refresh`. That was fine while only account pages
 * asked. Once the site *nav* had to know (`auth/SessionNav.tsx`), every
 * page view on the public marketing site was paying for an auth request,
 * for visitors who are overwhelmingly signed out — and in an environment
 * with no auth stack at all (the ephemeral PR environment) that request
 * never settles, which is how it was noticed.
 *
 * **It is a hint, never a credential and never an authorisation.** Absent
 * means "do not bother asking". Present means "ask" — and `/auth/refresh`
 * is still the only thing that decides. Forging it buys a wasted request
 * that answers 401. It is written and cleared in lockstep with the refresh
 * cookie and carries the identical `Max-Age`, so the two cannot disagree
 * about whether there is something to ask about.
 */
export const SESSION_HINT_COOKIE = 'ndn_session';

/** Matches TASK 2.2.1's `refreshTokenValidity` exactly — a cookie that outlives its token is a lie. */
export const REFRESH_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/**
 * The sign-in round trip is a redirect out and a redirect back. Ten
 * minutes is generous for that and short enough that an abandoned attempt
 * leaves nothing behind.
 */
export const PKCE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

export type PoolKey = 'patient' | 'clinician';

export interface PoolConfig {
  readonly clientId: string;
  /** The pool's hosted-UI base origin, e.g. `https://patient-login.nourishthenerve.com`. */
  readonly oauthBaseUrl: string;
}

export interface AuthTokenConfig {
  readonly pools: Record<PoolKey, PoolConfig>;
  readonly callbackUrl: string;
  readonly signOutUrl: string;
  /** The apex. Cookies are host-only on it; no `Domain` attribute is ever set. */
  readonly siteOrigin: string;
}

/**
 * Every auth cookie carries all four attributes, every time.
 *
 * `HttpOnly` — script cannot read it, which is the whole design.
 * `Secure` — it never travels over plaintext.
 * `SameSite=Lax` — a cross-site `POST` does not carry it, which together
 *   with these routes being `POST`-only is what covers CSRF here: an
 *   attacker's page can neither read the cookie nor make the browser send
 *   it on a form post it forged. A `GET` route bearing this cookie would
 *   break that, which is why the sign-in redirect sets cookies rather than
 *   spending them.
 * `Path=/` — the site and the API are the same origin (CloudFront proxies
 *   `/auth/*` to the HTTP API), so a narrower path would just be a way to
 *   lose the cookie after a rename.
 *
 * No `Domain` attribute, deliberately: that makes the cookie host-only on
 * the apex, so `next.nourishthenerve.com` — the same distribution under a
 * different name — never receives it.
 */
export function buildCookie(name: string, value: string, maxAgeSeconds: number): string {
  return [
    `${name}=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/**
 * The one cookie built *without* `HttpOnly`, because its whole purpose is
 * to be read by script — see `SESSION_HINT_COOKIE`. `Secure`, `SameSite`
 * and `Path` are unchanged: it is readable, not loose.
 */
export function buildSessionHintCookie(maxAgeSeconds: number): string {
  return [
    `${SESSION_HINT_COOKIE}=1`,
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/**
 * Its own clear, rather than the shared `clearCookie`. That helper stamps
 * `HttpOnly`, which would work — a browser removes a cookie by name, path
 * and domain, not by attribute — but it would mean this cookie went out
 * one shape when set and another when cleared, and the "every cookie but
 * this one carries HttpOnly" rule in auth-routes.test.ts would have to
 * carve out an exception to its own exception. Symmetry is cheaper.
 */
export function clearSessionHintCookie(): string {
  return buildSessionHintCookie(0).replace(`${SESSION_HINT_COOKIE}=1`, `${SESSION_HINT_COOKIE}=`);
}

/** `Max-Age=0` with an empty value — the only way to remove a cookie the browser holds. */
export function clearCookie(name: string): string {
  return buildCookie(name, '', 0);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const entries: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    entries[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return entries;
}

/** RFC 7636 S256. `randomBytes` rather than anything seeded — this is a one-time secret. */
export function createPkcePair(random: () => Buffer = () => randomBytes(32)): {
  verifier: string;
  challenge: string;
} {
  const verifier = random().toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// D-34 (2026-08-31): found live — the clinician pool's web client now
// carries `aws.cognito.signin.user.admin` (auth-stack.ts's own
// `extraScopes` header has the full story: without it, a signed-in
// clinician's access token can never call `ChangePassword`, no matter how
// correct the current password is, and Cognito's own error for that
// makes it look like the *password* is wrong). This is that scope's
// counterpart on the request side — an app client only *may* request a
// scope it's configured with, so a clinician sign-in has to actually ask
// for this one or the issued token still comes back without it. `email`
// requests both `email` and `email_verified` per OIDC, unaffected.
// 2026-08-31: the patient client now carries `aws.cognito.signin.user.admin`
// too (auth-stack.ts), so a patient sign-in has to actually request it —
// an app client only *may* request a scope it is configured with, and a
// token issued without it cannot call `ChangePassword` no matter how
// correct the password is. Same trap D-34 fell into on the clinician side
// and the same fix.
const PATIENT_SCOPE = 'openid email aws.cognito.signin.user.admin';
const CLINICIAN_SCOPE = 'openid email aws.cognito.signin.user.admin';

export function authorizeUrl(
  config: AuthTokenConfig,
  pool: PoolKey,
  challenge: string,
  state: string,
): string {
  const { clientId, oauthBaseUrl } = config.pools[pool];
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: config.callbackUrl,
    scope: pool === 'clinician' ? CLINICIAN_SCOPE : PATIENT_SCOPE,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
    // **`prompt=login` — 2026-09-02, and it closes a real hole on a shared
    // machine.**
    //
    // Cognito keeps its own hosted-UI session cookie, independent of this
    // site's. Without this parameter, `/oauth2/authorize` reuses it: the
    // redirect bounces straight back with a code and the visitor is signed
    // in **without being asked for anything**. `signOut`'s own doc in
    // apps/web/src/auth/session.ts already records that cookie biting once
    // (2026-08-31), and 2026-09-02 is the second time — the owner, signed
    // in as the principal clinician, clicked "Patient sign in" and was put
    // straight into a test patient's account.
    //
    // Hiding that link while signed in (`auth/SessionNav.tsx`) fixes the
    // path they took. It does not fix the worse one: on a clinic machine
    // where a patient signed in earlier and the browser was closed rather
    // than signed out, *anyone* clicking "Patient sign in" lands inside
    // that patient's account, having typed nothing. For a system holding
    // clinical records that is not a convenience, it is an unlocked door.
    //
    // `prompt=login` makes Cognito ask every time, whatever it remembers.
    // The cost is that a returning user types their password instead of
    // being signed in silently — which is what "sign in" is supposed to
    // mean here. **To reverse it, delete this one line**; nothing else
    // depends on it.
    prompt: 'login',
  });
  return `${oauthBaseUrl}/oauth2/authorize?${query.toString()}`;
}

/**
 * Amendment, 2026-08-31: found live — `/oauth2/revoke` (this file's own
 * `OAuthClient.revoke`) invalidates the refresh token server-side, but
 * does nothing about the *browser's* own Cognito hosted-UI session
 * cookie, set on `oauthBaseUrl`'s own domain the moment a sign-in
 * completes there. Revoking the token makes this app's own session
 * genuinely dead — `/auth/refresh` correctly starts returning 401 — but
 * the next `GET /auth/signin` still redirects into a browser Cognito
 * still recognises as signed in, which is confusing at best ("you are
 * already signed in") and at worst re-authenticates silently, with no
 * credential ever re-entered. Cognito's own `/logout` endpoint is the
 * one thing that clears that cookie — this is that endpoint's URL, the
 * `GET /auth/signin`-flow's own `authorizeUrl` above shaped the same
 * way. `logout_uri` must exactly match one of the app client's own
 * registered `logoutUrls` (auth-stack.ts) or Cognito refuses the
 * request outright, the identical constraint `redirect_uri` above is
 * already under.
 */
export function logoutUrl(config: AuthTokenConfig, pool: PoolKey): string {
  const { clientId, oauthBaseUrl } = config.pools[pool];
  const query = new URLSearchParams({ client_id: clientId, logout_uri: config.signOutUrl });
  return `${oauthBaseUrl}/logout?${query.toString()}`;
}

/** What Cognito's `/oauth2/token` returns, reduced to what this system uses. */
export interface TokenSet {
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
}

export interface OAuthClient {
  exchangeCode(pool: PoolKey, code: string, verifier: string, redirectUri: string): Promise<TokenSet>;
  refresh(pool: PoolKey, refreshToken: string): Promise<TokenSet>;
  revoke(pool: PoolKey, refreshToken: string): Promise<void>;
}

/**
 * The refresh cookie has to say which pool minted it, or `/auth/refresh`
 * would have to guess. `<pool>.<token>` — the pool name is not a secret
 * and a token never contains a dot outside its own JWT structure, which
 * this value is not (a Cognito refresh token is opaque).
 */
export function encodeRefreshCookie(pool: PoolKey, token: string): string {
  return `${pool}.${encodeURIComponent(token)}`;
}

export function decodeRefreshCookie(
  value: string | undefined,
): { pool: PoolKey; token: string } | undefined {
  if (!value) return undefined;
  const index = value.indexOf('.');
  if (index <= 0) return undefined;
  const pool = value.slice(0, index);
  if (pool !== 'patient' && pool !== 'clinician') return undefined;
  const token = decodeURIComponent(value.slice(index + 1));
  return token.length > 0 ? { pool, token } : undefined;
}
