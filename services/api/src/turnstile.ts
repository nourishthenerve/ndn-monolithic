// TASK 1.4.1 (C-11): server-side verification of a Cloudflare Turnstile
// token against the public `siteverify` endpoint. Plain `fetch` behind an
// injected `Fetcher` — same seam smoke-test.ts uses for its own outbound
// HTTP call — so no test in this repo ever reaches challenges.cloudflare.com
// for real; contact-form-handler.ts is the only place that resolves the
// real secret key (SSM SecureString, D-14) and passes the default `fetch`.
import { z } from 'zod';

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export type Fetcher = (
  url: string,
  init: RequestInit,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export type TurnstileVerifier = (token: string) => Promise<boolean>;

const turnstileResponseSchema = z.object({ success: z.boolean() });

export interface TurnstileVerifierOptions {
  readonly secretKey: string;
  readonly fetcher?: Fetcher;
}

/**
 * Never throws — a network error, a non-2xx response, or an unparseable
 * body are all treated the same as an explicit `success: false`: reject the
 * submission rather than fail open. An empty token is rejected without a
 * network call at all.
 */
export function createTurnstileVerifier(options: TurnstileVerifierOptions): TurnstileVerifier {
  const fetcher = options.fetcher ?? fetch;

  return async (token: string) => {
    if (!token) {
      return false;
    }
    try {
      const response = await fetcher(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: options.secretKey, response: token }).toString(),
      });
      if (!response.ok) {
        return false;
      }
      const parsed = turnstileResponseSchema.safeParse(await response.json());
      return parsed.success && parsed.data.success;
    } catch {
      return false;
    }
  };
}
