// TASK 2.2.4: the four `/auth/*` routes, as one handler. SDK-free and
// unit-testable — `auth-token-handler.ts` wires the real HTTP client.
//
// **Four routes where the plan named three.** `/auth/token`,
// `/auth/refresh` and `/auth/signout` are the plan's; `GET /auth/signin`
// is the one it did not name, and it exists because of the plan's own
// constraint. PKCE needs a verifier generated before the redirect to
// Cognito and read back after it, and the two obvious homes for it —
// `sessionStorage` and an in-memory variable — are respectively forbidden
// by this task's own "Do NOT" list and destroyed by the full-page
// redirect. Generating it server-side and parking it in an `HttpOnly`
// cookie is the only place left where script cannot reach it.
//
// It being a `GET` that redirects is a second, smaller win: the sign-in
// control is an ordinary link. It works with JavaScript disabled, it is
// keyboard-reachable because it is an anchor, and there is no click
// handler for the a11y suite to catch out.
import {
  authorizeUrl,
  buildCookie,
  clearCookie,
  createPkcePair,
  decodeRefreshCookie,
  encodeRefreshCookie,
  parseCookies,
  PKCE_COOKIE,
  PKCE_COOKIE_MAX_AGE_SECONDS,
  REFRESH_COOKIE,
  REFRESH_COOKIE_MAX_AGE_SECONDS,
  STATE_COOKIE,
  type AuthTokenConfig,
  type OAuthClient,
  type PoolKey,
} from './auth-token.js';
import type { FlagReader } from './flags.js';

export const WEB_SIGN_IN_FLAG = 'auth.webSignIn.enabled';

export interface AuthRouteRequest {
  readonly routeKey: string;
  readonly cookieHeader?: string;
  readonly body?: unknown;
  readonly query?: Record<string, string | undefined>;
}

export interface AuthRouteResponse {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  readonly cookies: string[];
  readonly body?: Record<string, unknown>;
}

export interface AuthRoutesDeps {
  readonly config: AuthTokenConfig;
  readonly oauth: OAuthClient;
  readonly flags: FlagReader;
  /** Injectable so a test can assert an exact `state`/verifier rather than a random one. */
  readonly randomBytes?: () => Buffer;
}

function poolFrom(value: unknown): PoolKey {
  // Anything that is not the clinician pool is the patient pool. A
  // caller-supplied value chooses which *sign-in page* to show, never a
  // role: the role comes from the issuer of the token that comes back
  // (2.2.2), so the worst a forged value here can do is send someone to
  // the wrong login form.
  return value === 'clinician' ? 'clinician' : 'patient';
}

const NO_STORE = { 'cache-control': 'no-store', 'content-type': 'application/json' };

export function createAuthRoutes(deps: AuthRoutesDeps) {
  const random = deps.randomBytes;

  return async (request: AuthRouteRequest): Promise<AuthRouteResponse> => {
    // Default off. With the flag off the site is exactly the brochure it
    // is today, and these routes do not exist rather than being present
    // and refusing.
    if (!(await deps.flags.isEnabled(WEB_SIGN_IN_FLAG))) {
      return { statusCode: 404, headers: NO_STORE, cookies: [], body: { error: 'NOT_FOUND' } };
    }

    const cookies = parseCookies(request.cookieHeader);
    const body = (request.body ?? {}) as Record<string, unknown>;

    switch (request.routeKey) {
      case 'GET /auth/signin': {
        const pool = poolFrom(request.query?.pool);
        const { verifier, challenge } = createPkcePair(random);
        const state = createPkcePair(random).verifier;
        return {
          statusCode: 302,
          headers: {
            location: authorizeUrl(deps.config, pool, challenge, state),
            'cache-control': 'no-store',
          },
          // The verifier and the state both ride as `HttpOnly` cookies.
          // The state cookie is what makes the callback check meaningful:
          // an attacker who can inject a `?code=` cannot also set a
          // matching cookie on our origin.
          cookies: [
            buildCookie(PKCE_COOKIE, `${pool}.${verifier}`, PKCE_COOKIE_MAX_AGE_SECONDS),
            buildCookie(STATE_COOKIE, state, PKCE_COOKIE_MAX_AGE_SECONDS),
          ],
        };
      }

      case 'POST /auth/token': {
        const code = typeof body.code === 'string' ? body.code : '';
        const state = typeof body.state === 'string' ? body.state : '';
        const stored = cookies[PKCE_COOKIE] ?? '';
        const separator = stored.indexOf('.');
        const pool = poolFrom(stored.slice(0, separator));
        const verifier = separator > 0 ? stored.slice(separator + 1) : '';

        // Every one of these is a refusal, and none of them says which.
        // A callback that reports *why* it failed is a callback that helps
        // someone probe it.
        if (!code || !verifier || !state || state !== cookies[STATE_COOKIE]) {
          return {
            statusCode: 400,
            headers: NO_STORE,
            cookies: [clearCookie(PKCE_COOKIE), clearCookie(STATE_COOKIE)],
            body: { error: 'INVALID_EXCHANGE' },
          };
        }

        const tokens = await deps.oauth.exchangeCode(
          pool,
          code,
          verifier,
          deps.config.callbackUrl,
        );

        return {
          statusCode: 200,
          headers: NO_STORE,
          cookies: [
            ...(tokens.refreshToken
              ? [
                  buildCookie(
                    REFRESH_COOKIE,
                    encodeRefreshCookie(pool, tokens.refreshToken),
                    REFRESH_COOKIE_MAX_AGE_SECONDS,
                  ),
                ]
              : []),
            // The one-time secrets are spent. Leaving them set would mean
            // a second exchange could be attempted with the same verifier.
            clearCookie(PKCE_COOKIE),
            clearCookie(STATE_COOKIE),
          ],
          // **The refresh token is not here.** Every response body on every
          // route in this file carries at most an access token and its
          // lifetime; there is a test that walks all four.
          body: { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn },
        };
      }

      case 'POST /auth/refresh': {
        const session = decodeRefreshCookie(cookies[REFRESH_COOKIE]);
        if (!session) {
          return {
            statusCode: 401,
            headers: NO_STORE,
            cookies: [],
            body: { error: 'NO_SESSION' },
          };
        }

        const tokens = await deps.oauth.refresh(session.pool, session.token);
        return {
          statusCode: 200,
          headers: NO_STORE,
          // Cognito may rotate the refresh token. When it does, the cookie
          // is replaced; when it does not, the existing one still has its
          // own life and is left alone rather than re-stamped with a fresh
          // 30 days it did not earn.
          cookies: tokens.refreshToken
            ? [
                buildCookie(
                  REFRESH_COOKIE,
                  encodeRefreshCookie(session.pool, tokens.refreshToken),
                  REFRESH_COOKIE_MAX_AGE_SECONDS,
                ),
              ]
            : [],
          body: { accessToken: tokens.accessToken, expiresIn: tokens.expiresIn },
        };
      }

      case 'POST /auth/signout': {
        const session = decodeRefreshCookie(cookies[REFRESH_COOKIE]);
        if (session) {
          // **Revoked at Cognito, not merely forgotten here.** Dropping the
          // cookie would leave a live credential in whatever captured it;
          // TASK 2.2.1 turned `enableTokenRevocation` on for exactly this
          // call. A revocation failure is swallowed: the cookie still goes,
          // and a sign-out that appears to fail is worse than one whose
          // server-side half needs retrying.
          await deps.oauth.revoke(session.pool, session.token).catch(() => undefined);
        }
        return {
          statusCode: 200,
          headers: NO_STORE,
          cookies: [clearCookie(REFRESH_COOKIE), clearCookie(PKCE_COOKIE), clearCookie(STATE_COOKIE)],
          body: { status: 'signed-out' },
        };
      }

      default:
        return { statusCode: 404, headers: NO_STORE, cookies: [], body: { error: 'NOT_FOUND' } };
    }
  };
}
