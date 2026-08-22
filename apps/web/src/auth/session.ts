// TASK 2.2.4: the browser's half of the session, and the only place an
// access token exists on this site.
//
// **It lives in a closure.** Not on `window`, not in a module-level
// mutable export another module could reach, not in `localStorage` or
// `sessionStorage` — the storage this task forbids, because a long-lived
// credential to a patient's clinical record must not be readable by any
// script that gets onto the page. The refresh token never reaches the
// browser at all: it is an `HttpOnly` cookie set by `/auth/token`
// (services/api/src/auth-token.ts), and the only thing that can spend it
// is a same-origin `POST` the browser makes without ever seeing it.
//
// Everything here is a same-origin `fetch` to `/auth/*`, which CloudFront
// proxies to the HTTP API — so the CSP shipped at 1.2.3 already covers it
// and no `connect-src` exception was needed.

export interface Session {
  /** Held for its hour and then refreshed. Never persisted. */
  readonly accessToken: string;
  readonly expiresAt: number;
}

export type SessionState =
  /** Nothing has been asked yet — `RequireAuth` renders nothing in this state. */
  | { readonly status: 'unknown' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly session: Session };

export interface SessionClient {
  /** Resolves the current session, refreshing from the cookie if there is one. */
  resolve(): Promise<SessionState>;
  /** Exchanges a callback `code`. Returns `signed-out` if the exchange is refused. */
  complete(code: string, state: string): Promise<SessionState>;
  signOut(): Promise<void>;
  /** The access token, refreshed at most once if it has expired. */
  authorization(): Promise<string | undefined>;
}

type Fetcher = typeof fetch;

interface TokenResponse {
  accessToken?: unknown;
  expiresIn?: unknown;
}

/** A minute of headroom, so a token never expires mid-flight on a slow request. */
const EXPIRY_SKEW_MS = 60_000;

export function createSessionClient(options: { fetcher?: Fetcher; now?: () => number } = {}): SessionClient {
  const fetcher = options.fetcher ?? ((...args: Parameters<Fetcher>) => fetch(...args));
  const now = options.now ?? (() => Date.now());

  // The closure. Nothing outside this function can read it, and the module
  // exports no accessor for it.
  let session: Session | undefined;
  let resolving: Promise<SessionState> | undefined;

  function adopt(payload: TokenResponse): SessionState {
    const accessToken = typeof payload.accessToken === 'string' ? payload.accessToken : '';
    const expiresIn = typeof payload.expiresIn === 'number' ? payload.expiresIn : 0;
    if (!accessToken) {
      session = undefined;
      return { status: 'signed-out' };
    }
    session = { accessToken, expiresAt: now() + expiresIn * 1000 };
    return { status: 'signed-in', session };
  }

  async function post(path: string, body?: unknown): Promise<SessionState> {
    const response = await fetcher(path, {
      method: 'POST',
      // Same-origin, and the cookie must ride along — the whole design
      // rests on the browser sending a credential it cannot read.
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      session = undefined;
      return { status: 'signed-out' };
    }
    return adopt((await response.json()) as TokenResponse);
  }

  return {
    async resolve() {
      if (session && session.expiresAt - EXPIRY_SKEW_MS > now()) {
        return { status: 'signed-in', session };
      }
      // **Exactly one refresh in flight, ever.** Two components mounting
      // at once must not each spend the cookie, and a failed refresh must
      // not retry itself — that is the loop this deduplication exists to
      // make unrepresentable.
      resolving ??= post('/auth/refresh').finally(() => {
        resolving = undefined;
      });
      return resolving;
    },

    async complete(code, state) {
      return post('/auth/token', { code, state });
    },

    async signOut() {
      session = undefined;
      await post('/auth/signout');
    },

    async authorization() {
      const state = await this.resolve();
      return state.status === 'signed-in' ? state.session.accessToken : undefined;
    },
  };
}
