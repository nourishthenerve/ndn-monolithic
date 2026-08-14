// TASK 1.4.1 (FR-WEB-04, C-11): the contact form's business rules, kept
// deliberately SDK-free and HTTP-free — same shape as sms.ts's
// createSmsSender, not content-authoring.ts's HTTP-shaped handler, so this
// gate-in-order logic (Turnstile → rate limit → send) is unit-testable with
// zero AWS and could in principle be driven by a channel other than API
// Gateway later. contact-form-handler.ts is the HTTP boundary: it parses
// the untrusted request body, hashes the caller's IP into `principal`
// before this file ever sees it, and maps ContactResult to a status code.
import type { RateLimiter } from './rate-limiter.js';
import type { EmailSender } from './ses.js';
import type { TurnstileVerifier } from './turnstile.js';

// C-11 / this task's own DoD: "Turnstile and the rate limit both
// demonstrably block abuse." One principal (a hashed source IP) may submit
// at most this many messages per hour.
export const CONTACT_FORM_RATE_LIMIT_PER_PRINCIPAL = 3;
export const CONTACT_FORM_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export type ContactResult =
  { kind: 'sent' } | { kind: 'blocked'; reason: 'turnstile' | 'rateLimited' };

export interface ContactRequest {
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly turnstileToken: string;
  /**
   * A hashed identity for rate limiting — contact-form-handler.ts hashes
   * the caller's source IP (SHA-256) before building this request; this
   * file never receives, stores, or logs the raw address.
   */
  readonly principal: string;
}

export interface ContactFormDeps {
  readonly verifyTurnstile: TurnstileVerifier;
  readonly rateLimiter: RateLimiter;
  readonly sendEmail: EmailSender;
}

export function createContactFormHandler(
  deps: ContactFormDeps,
): (req: ContactRequest) => Promise<ContactResult> {
  return async (req) => {
    // Gate 1: Turnstile. Checked first and without touching the rate
    // limiter — a bot hammering the endpoint with invalid tokens must not
    // be able to burn a legitimate visitor's rate-limit budget by spoofing
    // their principal, and a human who fails the challenge shouldn't lose
    // one of their own three tries either.
    const turnstileOk = await deps.verifyTurnstile(req.turnstileToken);
    if (!turnstileOk) {
      return { kind: 'blocked', reason: 'turnstile' };
    }

    // Gate 2: rate limit, only after a real human has passed Turnstile.
    const withinRate = await deps.rateLimiter.tryConsume(req.principal);
    if (!withinRate) {
      return { kind: 'blocked', reason: 'rateLimited' };
    }

    // Gate 3: send. No further guard after this — a successful send is a
    // terminal outcome, same as sms.ts's final `{ ok: true, status: 'Sent' }`.
    await deps.sendEmail({ name: req.name, email: req.email, message: req.message });
    return { kind: 'sent' };
  };
}
