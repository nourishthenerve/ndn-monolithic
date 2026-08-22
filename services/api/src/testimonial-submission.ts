// TASK 1.4.2 step 3: "Public submission form reuses 1.4.1's Turnstile +
// rate-limiter.ts directly — no second anti-abuse implementation." Same
// gate-in-order shape as contact-form.ts (Turnstile -> rate limit -> write),
// kept SDK-free and HTTP-free so it's unit-testable with zero AWS.
// testimonial-submission-handler.ts is the HTTP boundary: it parses the
// untrusted request body, generates the id, hashes the submitter's contact
// detail into `consent.submitterContactHash` before this file ever sees it,
// and maps TestimonialSubmissionResult to a status code.
import type { Testimonial } from '@ndn/shared-types';

import type { ActorContext } from './audit.js';
import type { RateLimiter } from './rate-limiter.js';
import type { SubmitTestimonialInput, TestimonialRepository } from './testimonial-repository.js';
import type { TurnstileVerifier } from './turnstile.js';

// Same per-principal budget as the contact form (contact-form.ts) — the
// shared rate-limiter shape, not necessarily the same running instance
// (testimonial-submission-handler.ts wires its own, scoped to this route).
export const TESTIMONIAL_SUBMISSION_RATE_LIMIT_PER_PRINCIPAL = 3;
export const TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export type TestimonialSubmissionResult =
  | { kind: 'submitted'; testimonial: Testimonial }
  | { kind: 'blocked'; reason: 'turnstile' | 'rateLimited' };

export interface TestimonialSubmissionRequest {
  readonly data: SubmitTestimonialInput;
  readonly turnstileToken: string;
  /**
   * A hashed identity for rate limiting — testimonial-submission-handler.ts
   * hashes the caller's source IP (SHA-256), same as contact-form-handler.ts;
   * this file never receives, stores, or logs the raw address.
   */
  readonly principal: string;
  /**
   * The audit trail's actor (TASK 2.1.3). Its `subjectId` is the same hash
   * as `principal` above, because an unauthenticated visitor's origin *is*
   * the only identifier they have — and its role is `'public'` rather than
   * a clinical one, so a reviewer reading a day's rows can tell a
   * visitor's submission from a moderator's decision at a glance. There is
   * still no user identity here; the same gap admin-auth.ts documents for
   * authoring, closed by TASK 2.2.x.
   */
  readonly actor: ActorContext;
}

export interface TestimonialSubmissionDeps {
  readonly verifyTurnstile: TurnstileVerifier;
  readonly rateLimiter: RateLimiter;
  readonly repository: TestimonialRepository;
}

export function createTestimonialSubmissionHandler(
  deps: TestimonialSubmissionDeps,
): (req: TestimonialSubmissionRequest) => Promise<TestimonialSubmissionResult> {
  return async (req) => {
    // Gate 1: Turnstile, checked before the rate limiter — same reasoning
    // contact-form.ts documents: a bot spoofing principals must not be able
    // to burn a legitimate visitor's budget, and a human who fails the
    // challenge shouldn't lose one of their own tries either.
    const turnstileOk = await deps.verifyTurnstile(req.turnstileToken);
    if (!turnstileOk) {
      return { kind: 'blocked', reason: 'turnstile' };
    }

    // Gate 2: rate limit, only after a real human has passed Turnstile.
    const withinRate = await deps.rateLimiter.tryConsume(req.principal);
    if (!withinRate) {
      return { kind: 'blocked', reason: 'rateLimited' };
    }

    // Gate 3: write. Always lands as 'pending_review' (TestimonialRepository.submit)
    // — a submission is never immediately public, so a spammer who clears
    // both gates still needs a human moderator's publish before anything shows.
    const testimonial = await deps.repository.submit(req.actor, req.data);
    return { kind: 'submitted', testimonial };
  };
}
