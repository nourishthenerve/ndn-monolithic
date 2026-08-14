import { describe, expect, it, vi } from 'vitest';

import { createTurnstileVerifier, type Fetcher } from './turnstile.js';

describe('createTurnstileVerifier', () => {
  it('returns true when siteverify reports success', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    const verify = createTurnstileVerifier({ secretKey: 'secret', fetcher });

    await expect(verify('a-real-token')).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('sends the secret and the token in the request body', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });
    const verify = createTurnstileVerifier({ secretKey: 'my-secret', fetcher });
    await verify('the-token');

    const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get('secret')).toBe('my-secret');
    expect(body.get('response')).toBe('the-token');
  });

  it('returns false when siteverify reports failure', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    const verify = createTurnstileVerifier({ secretKey: 'secret', fetcher });

    await expect(verify('a-bad-token')).resolves.toBe(false);
  });

  it('returns false on a non-2xx response, without throwing', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    const verify = createTurnstileVerifier({ secretKey: 'secret', fetcher });

    await expect(verify('a-token')).resolves.toBe(false);
  });

  it('returns false when the fetch itself throws, without throwing', async () => {
    const fetcher: Fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    const verify = createTurnstileVerifier({ secretKey: 'secret', fetcher });

    await expect(verify('a-token')).resolves.toBe(false);
  });

  it('returns false on an unparseable response body, without throwing', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    });
    const verify = createTurnstileVerifier({ secretKey: 'secret', fetcher });

    await expect(verify('a-token')).resolves.toBe(false);
  });

  it('returns false for an empty token without calling fetch', async () => {
    const fetcher: Fetcher = vi.fn();
    const verify = createTurnstileVerifier({ secretKey: 'secret', fetcher });

    await expect(verify('')).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
