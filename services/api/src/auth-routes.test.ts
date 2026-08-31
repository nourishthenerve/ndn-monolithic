// TASK 2.2.4. The properties under test are all negative: nothing script
// can read holds a credential, no response body leaks a refresh token, and
// every cookie carries every attribute — the last one table-driven, so
// dropping a single attribute fails rather than passing on a partial match.
import { describe, expect, it, vi } from 'vitest';

import { createAuthRoutes, WEB_SIGN_IN_FLAG, type AuthRouteRequest } from './auth-routes.js';
import {
  parseCookies,
  PKCE_COOKIE,
  REFRESH_COOKIE,
  STATE_COOKIE,
  type AuthTokenConfig,
  type OAuthClient,
} from './auth-token.js';
import type { FlagReader } from './flags.js';

const CONFIG: AuthTokenConfig = {
  pools: {
    patient: {
      clientId: 'patient-client',
      oauthBaseUrl: 'https://ndn-patients.auth.eu-west-2.amazoncognito.com',
    },
    clinician: {
      clientId: 'clinician-client',
      oauthBaseUrl: 'https://ndn-clinicians.auth.eu-west-2.amazoncognito.com',
    },
  },
  callbackUrl: 'https://nourishthenerve.com/en/account/callback',
  signOutUrl: 'https://nourishthenerve.com/',
  siteOrigin: 'https://nourishthenerve.com',
};

const ACCESS_TOKEN = 'header.payload.signature';
const REFRESH_TOKEN = 'opaque-refresh-token-value';

function flags(enabled: boolean): FlagReader {
  return { isEnabled: async (name) => (name === WEB_SIGN_IN_FLAG ? enabled : false) };
}

function build(options: { enabled?: boolean; rotate?: boolean } = {}) {
  const exchangeCode = vi.fn(async () => ({
    accessToken: ACCESS_TOKEN,
    refreshToken: REFRESH_TOKEN,
    expiresIn: 3600,
  }));
  const refresh = vi.fn(async () => ({
    accessToken: 'refreshed.access.token',
    refreshToken: options.rotate ? 'rotated-refresh-token' : undefined,
    expiresIn: 3600,
  }));
  const revoke = vi.fn(async () => {});
  const oauth: OAuthClient = { exchangeCode, refresh, revoke };

  // Deterministic verifier/state, so the assertions can be exact.
  let counter = 0;
  const routes = createAuthRoutes({
    config: CONFIG,
    oauth,
    flags: flags(options.enabled ?? true),
    randomBytes: () => Buffer.alloc(32, ++counter),
  });
  return { routes, exchangeCode, refresh, revoke };
}

function signInRequest(pool?: string): AuthRouteRequest {
  return { routeKey: 'GET /auth/signin', query: pool === undefined ? {} : { pool } };
}

/** The two one-time cookies a real callback would carry back. */
async function startedSession(pool?: string) {
  const { routes, ...rest } = build();
  const start = await routes(signInRequest(pool));
  const set = Object.fromEntries(
    start.cookies.map((cookie) => [cookie.slice(0, cookie.indexOf('=')), cookie]),
  );
  const values = parseCookies(start.cookies.map((cookie) => cookie.split(';')[0]).join('; '));
  return { routes, start, set, values, ...rest };
}

describe('the flag is the outermost gate on every route', () => {
  it.each([
    'GET /auth/signin',
    'POST /auth/token',
    'POST /auth/refresh',
    'POST /auth/signout',
  ])('answers 404 on %s when sign-in is off', async (routeKey) => {
    const { routes } = build({ enabled: false });
    const response = await routes({ routeKey });

    expect(response.statusCode).toBe(404);
    expect(response.cookies).toEqual([]);
  });
});

describe('GET /auth/signin', () => {
  it('redirects to the pool authorize endpoint with an S256 challenge', async () => {
    const { start } = await startedSession();
    const url = new URL(start.headers.location ?? '');

    expect(start.statusCode).toBe(302);
    expect(url.origin).toBe(CONFIG.pools.patient.oauthBaseUrl);
    expect(url.pathname).toBe('/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('patient-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe(CONFIG.callbackUrl);
    expect(url.searchParams.get('scope')).toBe('openid email');
  });

  it('sends a clinician to the clinician pool', async () => {
    const { start } = await startedSession('clinician');

    expect(start.headers.location).toContain('ndn-clinicians.auth');
    expect(new URL(start.headers.location ?? '').searchParams.get('client_id')).toBe(
      'clinician-client',
    );
  });

  it('treats any unrecognised pool as the patient pool', async () => {
    // The value picks a sign-in *page*, never a role — the role comes from
    // the issuer of the token that comes back (2.2.2). The worst a forged
    // value can do is show someone the wrong form.
    const { start } = await startedSession('principal-clinician');

    expect(start.headers.location).toContain('ndn-patients.auth');
  });

  it('never puts the verifier in the redirect URL, only its hash', async () => {
    const { start, values } = await startedSession();
    const verifier = (values[PKCE_COOKIE] ?? '').split('.')[1];

    expect(verifier).toBeTruthy();
    expect(start.headers.location).not.toContain(verifier!);
  });

  it('sets a state cookie the callback must match', async () => {
    const { start, values } = await startedSession();

    expect(new URL(start.headers.location ?? '').searchParams.get('state')).toBe(
      values[STATE_COOKIE],
    );
  });
});

describe('POST /auth/token', () => {
  async function exchange(overrides: { code?: string; state?: string; cookies?: string } = {}) {
    const session = await startedSession();
    const cookieHeader =
      overrides.cookies ??
      `${PKCE_COOKIE}=${session.values[PKCE_COOKIE]}; ${STATE_COOKIE}=${session.values[STATE_COOKIE]}`;
    const response = await session.routes({
      routeKey: 'POST /auth/token',
      cookieHeader,
      body: {
        code: overrides.code ?? 'authorization-code',
        state: overrides.state ?? session.values[STATE_COOKIE],
      },
    });
    return { ...session, response };
  }

  it('exchanges the code with the verifier from the cookie', async () => {
    const { response, exchangeCode, values } = await exchange();

    expect(response.statusCode).toBe(200);
    expect(exchangeCode).toHaveBeenCalledWith(
      'patient',
      'authorization-code',
      (values[PKCE_COOKIE] ?? '').split('.')[1],
      CONFIG.callbackUrl,
    );
  });

  it('returns the access token in the body and the refresh token only as a cookie', async () => {
    const { response } = await exchange();

    expect(response.body).toEqual({ accessToken: ACCESS_TOKEN, expiresIn: 3600 });
    expect(JSON.stringify(response.body)).not.toContain(REFRESH_TOKEN);
    expect(response.cookies.join('\n')).toContain(REFRESH_TOKEN);
  });

  it('spends the one-time cookies so the same verifier cannot be reused', async () => {
    const { response } = await exchange();
    const cleared = response.cookies.filter((cookie) => cookie.includes('Max-Age=0'));

    expect(cleared.some((cookie) => cookie.startsWith(`${PKCE_COOKIE}=`))).toBe(true);
    expect(cleared.some((cookie) => cookie.startsWith(`${STATE_COOKIE}=`))).toBe(true);
  });

  it.each([
    ['no code', { code: '' }],
    ['no state', { state: '' }],
    ['a state that does not match the cookie', { state: 'someone-elses-state' }],
    ['no cookies at all', { cookies: '' }],
  ])('refuses %s without saying which', async (_name, overrides) => {
    const { response, exchangeCode } = await exchange(overrides);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'INVALID_EXCHANGE' });
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it('clears the one-time cookies even when it refuses', async () => {
    const { response } = await exchange({ state: 'wrong' });

    expect(response.cookies.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });
});

describe('POST /auth/refresh', () => {
  const cookieHeader = `${REFRESH_COOKIE}=patient.${encodeURIComponent(REFRESH_TOKEN)}`;

  it('refreshes against the pool the cookie names', async () => {
    const { routes, refresh } = build();
    const response = await routes({ routeKey: 'POST /auth/refresh', cookieHeader });

    expect(response.statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledWith('patient', REFRESH_TOKEN);
    expect(response.body).toEqual({ accessToken: 'refreshed.access.token', expiresIn: 3600 });
  });

  it('answers 401 with no session rather than starting one', async () => {
    const { routes, refresh } = build();
    const response = await routes({ routeKey: 'POST /auth/refresh' });

    expect(response.statusCode).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    ['a cookie naming no pool', `${REFRESH_COOKIE}=just-a-token`],
    ['a cookie naming an unknown pool', `${REFRESH_COOKIE}=admin.${REFRESH_TOKEN}`],
    ['an empty token', `${REFRESH_COOKIE}=patient.`],
  ])('answers 401 for %s', async (_name, header) => {
    const { routes, refresh } = build();
    const response = await routes({ routeKey: 'POST /auth/refresh', cookieHeader: header });

    expect(response.statusCode).toBe(401);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('replaces the cookie when Cognito rotates the refresh token', async () => {
    const { routes } = build({ rotate: true });
    const response = await routes({ routeKey: 'POST /auth/refresh', cookieHeader });

    expect(response.cookies.join('\n')).toContain('rotated-refresh-token');
  });

  it('leaves the cookie alone when Cognito does not rotate', async () => {
    // Re-stamping it would hand the session a fresh 30 days it did not earn.
    const { routes } = build();
    const response = await routes({ routeKey: 'POST /auth/refresh', cookieHeader });

    expect(response.cookies).toEqual([]);
  });
});

describe('POST /auth/signout', () => {
  const cookieHeader = `${REFRESH_COOKIE}=patient.${encodeURIComponent(REFRESH_TOKEN)}`;

  it('revokes at Cognito rather than merely forgetting the cookie', async () => {
    // Dropping the cookie leaves a live credential in whatever captured it.
    const { routes, revoke } = build();
    await routes({ routeKey: 'POST /auth/signout', cookieHeader });

    expect(revoke).toHaveBeenCalledWith('patient', REFRESH_TOKEN);
  });

  it('clears every auth cookie', async () => {
    const { routes } = build();
    const response = await routes({ routeKey: 'POST /auth/signout', cookieHeader });
    const cleared = response.cookies.map((cookie) => cookie.slice(0, cookie.indexOf('=')));

    expect(cleared.sort()).toEqual([PKCE_COOKIE, REFRESH_COOKIE, STATE_COOKIE].sort());
    expect(response.cookies.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('still signs the browser out when revocation fails', async () => {
    const { routes, revoke } = build();
    revoke.mockRejectedValue(new Error('TooManyRequestsException'));
    const response = await routes({ routeKey: 'POST /auth/signout', cookieHeader });

    expect(response.statusCode).toBe(200);
    expect(response.cookies.some((cookie) => cookie.startsWith(`${REFRESH_COOKIE}=`))).toBe(true);
  });

  it('is harmless with no session', async () => {
    const { routes, revoke } = build();

    expect((await routes({ routeKey: 'POST /auth/signout' })).statusCode).toBe(200);
    expect(revoke).not.toHaveBeenCalled();
  });

  // Found live, 2026-08-31: revoking the refresh token kills this app's
  // own session but leaves Cognito's browser-side hosted-UI session
  // cookie live, so the next sign-in silently re-authenticated against
  // it instead of prompting again — "you are already signed in." The
  // client navigates to this URL, not `/`, once it responds.
  it('returns the pool\'s own Cognito logout URL for a real session', async () => {
    const { routes } = build();
    const response = await routes({ routeKey: 'POST /auth/signout', cookieHeader });

    const body = response.body as { logoutUrl?: string };
    const url = new URL(body.logoutUrl ?? '');
    expect(url.origin).toBe(CONFIG.pools.patient.oauthBaseUrl);
    expect(url.pathname).toBe('/logout');
    expect(url.searchParams.get('client_id')).toBe('patient-client');
    expect(url.searchParams.get('logout_uri')).toBe(CONFIG.signOutUrl);
  });

  it('sends a clinician to the clinician pool\'s own logout URL', async () => {
    const { routes } = build();
    const clinicianCookieHeader = `${REFRESH_COOKIE}=clinician.${encodeURIComponent(REFRESH_TOKEN)}`;
    const response = await routes({ routeKey: 'POST /auth/signout', cookieHeader: clinicianCookieHeader });

    const body = response.body as { logoutUrl?: string };
    expect(new URL(body.logoutUrl ?? '').origin).toBe(CONFIG.pools.clinician.oauthBaseUrl);
  });

  it('omits logoutUrl when there was no session — there is no pool to build one for', async () => {
    const { routes } = build();
    const response = await routes({ routeKey: 'POST /auth/signout' });

    expect(response.body).not.toHaveProperty('logoutUrl');
  });
});

describe('every cookie this file sets, on every route', () => {
  // Table-driven on purpose: an assertion per attribute means dropping one
  // fails loudly instead of passing a partial match.
  const REQUIRED_ATTRIBUTES = ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/'];

  async function allCookies(): Promise<string[]> {
    const session = await startedSession();
    const exchanged = await session.routes({
      routeKey: 'POST /auth/token',
      cookieHeader: `${PKCE_COOKIE}=${session.values[PKCE_COOKIE]}; ${STATE_COOKIE}=${session.values[STATE_COOKIE]}`,
      body: { code: 'code', state: session.values[STATE_COOKIE] },
    });
    const refreshed = await build({ rotate: true }).routes({
      routeKey: 'POST /auth/refresh',
      cookieHeader: `${REFRESH_COOKIE}=patient.${REFRESH_TOKEN}`,
    });
    const signedOut = await session.routes({
      routeKey: 'POST /auth/signout',
      cookieHeader: `${REFRESH_COOKIE}=patient.${REFRESH_TOKEN}`,
    });
    return [...session.start.cookies, ...exchanged.cookies, ...refreshed.cookies, ...signedOut.cookies];
  }

  it.each(REQUIRED_ATTRIBUTES)('carries %s', async (attribute) => {
    const cookies = await allCookies();

    expect(cookies.length).toBeGreaterThan(6);
    for (const cookie of cookies) {
      expect(cookie, cookie).toContain(attribute);
    }
  });

  it('sets no Domain attribute, so the cookie is host-only on the apex', async () => {
    // `next.nourishthenerve.com` is the same distribution under another
    // name; a Domain attribute would hand it the session.
    for (const cookie of await allCookies()) {
      expect(cookie.toLowerCase()).not.toContain('domain=');
    }
  });

  it('gives the refresh cookie exactly the refresh token\'s own life', async () => {
    const session = await startedSession();
    const exchanged = await session.routes({
      routeKey: 'POST /auth/token',
      cookieHeader: `${PKCE_COOKIE}=${session.values[PKCE_COOKIE]}; ${STATE_COOKIE}=${session.values[STATE_COOKIE]}`,
      body: { code: 'code', state: session.values[STATE_COOKIE] },
    });
    const refreshCookie = exchanged.cookies.find((cookie) =>
      cookie.startsWith(`${REFRESH_COOKIE}=`),
    );

    // 30 days, matching TASK 2.2.1's refreshTokenValidity. A cookie that
    // outlives its token is a lie to the browser.
    expect(refreshCookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
  });
});

describe('no response body on any route carries a refresh token', () => {
  it('holds across the whole surface', async () => {
    const session = await startedSession();
    const bodies = [
      session.start.body,
      (
        await session.routes({
          routeKey: 'POST /auth/token',
          cookieHeader: `${PKCE_COOKIE}=${session.values[PKCE_COOKIE]}; ${STATE_COOKIE}=${session.values[STATE_COOKIE]}`,
          body: { code: 'code', state: session.values[STATE_COOKIE] },
        })
      ).body,
      (
        await session.routes({
          routeKey: 'POST /auth/refresh',
          cookieHeader: `${REFRESH_COOKIE}=patient.${REFRESH_TOKEN}`,
        })
      ).body,
      (
        await session.routes({
          routeKey: 'POST /auth/signout',
          cookieHeader: `${REFRESH_COOKIE}=patient.${REFRESH_TOKEN}`,
        })
      ).body,
    ];

    expect(JSON.stringify(bodies)).not.toContain(REFRESH_TOKEN);
    expect(JSON.stringify(bodies)).not.toContain('refreshToken');
    expect(JSON.stringify(bodies)).not.toContain('refresh_token');
  });
});
