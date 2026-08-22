// TASK 2.2.4: the deployed Lambda entry for `/auth/*`
// (infra/src/web-stack.ts routes it; CloudFront proxies it same-origin so
// the whole flow stays on the apex and 1.2.3's CSP already covers it).
// Thin wiring — the routes and every cookie rule are auth-routes.ts and
// auth-token.ts, tested without AWS.
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { createAuthRoutes } from './auth-routes.js';
import type { AuthTokenConfig, OAuthClient, PoolKey, TokenSet } from './auth-token.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const config: AuthTokenConfig = {
  pools: {
    patient: {
      clientId: process.env.PATIENT_USER_POOL_CLIENT_ID ?? '',
      oauthBaseUrl: process.env.PATIENT_OAUTH_BASE_URL ?? '',
    },
    clinician: {
      clientId: process.env.CLINICIAN_USER_POOL_CLIENT_ID ?? '',
      oauthBaseUrl: process.env.CLINICIAN_OAUTH_BASE_URL ?? '',
    },
  },
  callbackUrl: process.env.AUTH_CALLBACK_URL ?? '',
  signOutUrl: process.env.AUTH_SIGN_OUT_URL ?? '',
  siteOrigin: process.env.SITE_ORIGIN ?? '',
};

/**
 * Plain `fetch` against Cognito's `/oauth2/*` endpoints rather than the
 * Cognito SDK: these are ordinary OAuth 2.0 endpoints, they take
 * `application/x-www-form-urlencoded`, and the clients are public so there
 * is no request signing and no credential to hold. Pulling in a service
 * client to post a form would add a megabyte to the bundle for nothing.
 */
function createOAuthClient(): OAuthClient {
  async function post(pool: PoolKey, path: string, form: Record<string, string>): Promise<unknown> {
    const response = await fetch(`${config.pools[pool].oauthBaseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.pools[pool].clientId, ...form }),
    });
    if (!response.ok) {
      // Nothing from Cognito's body is surfaced or logged: an OAuth error
      // response echoes request parameters, which on this path include a
      // code and a refresh token.
      throw new Error(`oauth request failed with ${response.status}`);
    }
    return response.json();
  }

  function toTokenSet(payload: unknown): TokenSet {
    const body = (payload ?? {}) as Record<string, unknown>;
    return {
      accessToken: typeof body.access_token === 'string' ? body.access_token : '',
      refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
      expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 0,
    };
  }

  return {
    async exchangeCode(pool, code, verifier, redirectUri) {
      return toTokenSet(
        await post(pool, '/oauth2/token', {
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      );
    },
    async refresh(pool, refreshToken) {
      return toTokenSet(
        await post(pool, '/oauth2/token', {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }),
      );
    },
    async revoke(pool, refreshToken) {
      await post(pool, '/oauth2/revoke', { token: refreshToken });
    },
  };
}

const routes = createAuthRoutes({
  config,
  oauth: createOAuthClient(),
  flags: createSsmFlagReader(),
});

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const result = await routes({
    routeKey: event.routeKey ?? '',
    // API Gateway v2 splits cookies into their own array rather than
    // leaving a `Cookie` header; rejoining is the only translation this
    // wiring performs.
    cookieHeader: (event.cookies ?? []).join('; '),
    body: parseJsonBody(event),
    query: event.queryStringParameters,
  });

  return {
    statusCode: result.statusCode,
    headers: result.headers,
    cookies: result.cookies,
    body: result.body === undefined ? undefined : JSON.stringify(result.body),
  };
};
