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
  /** `https://<prefix>.auth.<region>.amazoncognito.com` */
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
    // Exactly TASK 2.2.1's app-client scopes. Asking for more here fails
    // at Cognito rather than silently widening anything, but asking for
    // the right ones means the failure never happens.
    scope: 'openid email',
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  });
  return `${oauthBaseUrl}/oauth2/authorize?${query.toString()}`;
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
