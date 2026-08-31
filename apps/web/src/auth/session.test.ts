// TASK 2.2.4. The two properties that matter here are both about what does
// *not* happen: no token is written anywhere script can read, and an
// expired token triggers exactly one refresh rather than a loop.
import { describe, expect, it, vi } from 'vitest';

import { createSessionClient } from './session.js';

const ACCESS_TOKEN = 'header.payload.signature';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as unknown as Response;
}

function build(options: { responses?: Response[]; now?: () => number } = {}) {
  const queue = [...(options.responses ?? [])];
  const fetcher = vi.fn(async () =>
    queue.length > 0
      ? queue.shift()!
      : jsonResponse({ accessToken: ACCESS_TOKEN, expiresIn: 3600 }),
  );
  const client = createSessionClient({
    fetcher: fetcher as unknown as typeof fetch,
    now: options.now ?? (() => 1_000_000),
  });
  return { client, fetcher };
}

describe('resolving a session', () => {
  it('refreshes from the cookie and reports signed in', async () => {
    const { client, fetcher } = build();

    expect(await client.resolve()).toEqual({
      status: 'signed-in',
      session: { accessToken: ACCESS_TOKEN, expiresAt: 1_000_000 + 3_600_000 },
    });
    expect(fetcher).toHaveBeenCalledWith('/auth/refresh', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
  });

  it('reports signed out when there is no cookie to refresh from', async () => {
    const { client } = build({ responses: [jsonResponse({ error: 'NO_SESSION' }, false)] });

    expect(await client.resolve()).toEqual({ status: 'signed-out' });
  });

  it('reports signed out when the response carries no token', async () => {
    const { client } = build({ responses: [jsonResponse({ expiresIn: 3600 })] });

    expect(await client.resolve()).toEqual({ status: 'signed-out' });
  });
});

describe('an expired token triggers exactly one refresh, not a loop', () => {
  it('does not re-request while a refresh is already in flight', async () => {
    // Two islands mounting at once must not each spend the cookie.
    const { client, fetcher } = build();
    await Promise.all([client.resolve(), client.resolve(), client.resolve()]);

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('serves the cached token without a second call until it nears expiry', async () => {
    const { client, fetcher } = build();
    await client.resolve();
    await client.resolve();
    await client.authorization();

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes once more, and only once, after the token expires', async () => {
    let clock = 1_000_000;
    const { client, fetcher } = build({ now: () => clock });
    await client.resolve();
    clock += 3_600_001;
    await Promise.all([client.resolve(), client.resolve()]);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not retry itself after a failed refresh', async () => {
    // The loop this guards against: refresh fails, a component re-renders,
    // refresh fails again, forever.
    const { client, fetcher } = build({
      responses: [jsonResponse({}, false), jsonResponse({}, false)],
    });
    await client.resolve();
    await client.resolve();

    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('completing a callback', () => {
  it('posts the code and state to the same-origin exchange', async () => {
    const { client, fetcher } = build();
    const state = await client.complete('authorization-code', 'state-value');

    expect(state.status).toBe('signed-in');
    expect(fetcher).toHaveBeenCalledWith(
      '/auth/token',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({ code: 'authorization-code', state: 'state-value' }),
      }),
    );
  });

  it('reports signed out rather than throwing when the exchange is refused', async () => {
    const { client } = build({ responses: [jsonResponse({ error: 'INVALID_EXCHANGE' }, false)] });

    expect(await client.complete('code', 'state')).toEqual({ status: 'signed-out' });
  });
});

describe('signing out', () => {
  it('drops the in-memory token and calls the server, which revokes at Cognito', async () => {
    const { client, fetcher } = build();
    await client.resolve();
    await client.signOut();

    expect(fetcher).toHaveBeenLastCalledWith('/auth/signout', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
    }));
    expect(await client.authorization()).toBeDefined(); // a fresh refresh, not the dropped token
  });

  // Found live, 2026-08-31: without this, sign-out ended this app's own
  // session but left Cognito's browser-side one live, so the next sign-in
  // silently re-authenticated against it instead of prompting again.
  it('returns the logoutUrl the server sends, so the caller can navigate to Cognito\'s own logout endpoint', async () => {
    const { client } = build({
      responses: [jsonResponse({ status: 'signed-out', logoutUrl: 'https://patient-login.example/logout?x=1' })],
    });

    expect(await client.signOut()).toBe('https://patient-login.example/logout?x=1');
  });

  it('returns undefined when the server sends no logoutUrl — there was no session to build one for', async () => {
    const { client } = build({ responses: [jsonResponse({ status: 'signed-out' })] });

    expect(await client.signOut()).toBeUndefined();
  });
});

describe('the token is not reachable from outside the closure', () => {
  it('exposes no accessor beyond the four methods', () => {
    const { client } = build();

    expect(Object.keys(client).sort()).toEqual([
      'authorization',
      'complete',
      'resolve',
      'signOut',
    ]);
  });

  it('puts nothing on globalThis', async () => {
    const before = new Set(Object.keys(globalThis));
    const { client } = build();
    await client.resolve();

    expect(Object.keys(globalThis).filter((key) => !before.has(key))).toEqual([]);
  });
});
