import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import {
  InMemoryTestimonialStore,
  TestimonialRepository,
  type SubmitTestimonialInput,
} from './testimonial-repository.js';
import {
  TESTIMONIAL_SUBMISSION_RATE_LIMIT_PER_PRINCIPAL,
  TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS,
  createTestimonialSubmissionHandler,
  type TestimonialSubmissionDeps,
  type TestimonialSubmissionRequest,
} from './testimonial-submission.js';

const fixedClock: Clock = { now: () => new Date('2026-08-10T09:00:00.000Z') };

function buildInput(overrides: Partial<SubmitTestimonialInput> = {}): SubmitTestimonialInput {
  return {
    id: 'testimonial-1',
    quote: { en: 'This service changed my recovery.' },
    attribution: { display: 'firstNameOnly', name: 'Jordan' },
    consent: { textVersion: '2026-08-14', submitterContactHash: 'hash-1' },
    ...overrides,
  };
}

const baseRequest: TestimonialSubmissionRequest = {
  data: buildInput(),
  turnstileToken: 'a-real-token',
  principal: 'hashed-principal-1',
};

function buildDeps(
  overrides: Partial<TestimonialSubmissionDeps> = {},
): TestimonialSubmissionDeps & {
  verifyTurnstile: ReturnType<typeof vi.fn>;
} {
  const repository = new TestimonialRepository(
    new InMemoryTestimonialStore(),
    new InMemoryAuditLog(),
    fixedClock,
  );
  return {
    verifyTurnstile: vi.fn().mockResolvedValue(true),
    rateLimiter: new InMemoryRateLimiter({
      clock: fixedClock,
      limit: TESTIMONIAL_SUBMISSION_RATE_LIMIT_PER_PRINCIPAL,
      windowMs: TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS,
    }),
    repository,
    ...overrides,
  } as TestimonialSubmissionDeps & { verifyTurnstile: ReturnType<typeof vi.fn> };
}

describe('createTestimonialSubmissionHandler', () => {
  it('submits as pending_review when Turnstile passes and the caller is under the rate limit', async () => {
    const deps = buildDeps();
    const handle = createTestimonialSubmissionHandler(deps);

    const result = await handle(baseRequest);
    expect(result.kind).toBe('submitted');
    if (result.kind === 'submitted') {
      expect(result.testimonial.status).toBe('pending_review');
      expect(result.testimonial.id).toBe('testimonial-1');
    }
  });

  it('is blocked/turnstile on a failed Turnstile check, and never writes a testimonial', async () => {
    const deps = buildDeps({ verifyTurnstile: vi.fn().mockResolvedValue(false) });
    const handle = createTestimonialSubmissionHandler(deps);

    await expect(handle(baseRequest)).resolves.toEqual({ kind: 'blocked', reason: 'turnstile' });
    expect(await deps.repository.findById('testimonial-1')).toBeUndefined();
  });

  it('a Turnstile-rejected attempt does not consume a rate-limit slot', async () => {
    const rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: 1,
      windowMs: TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS,
    });
    const deps = buildDeps({ verifyTurnstile: vi.fn().mockResolvedValue(false), rateLimiter });
    await createTestimonialSubmissionHandler(deps)(baseRequest);

    const deps2 = buildDeps({ rateLimiter });
    await expect(createTestimonialSubmissionHandler(deps2)(baseRequest)).resolves.toMatchObject({
      kind: 'submitted',
    });
  });

  it('is blocked/rateLimited once a principal exceeds its per-window allowance', async () => {
    const rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: TESTIMONIAL_SUBMISSION_RATE_LIMIT_PER_PRINCIPAL,
      windowMs: TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS,
    });
    const deps = buildDeps({ rateLimiter });
    const handle = createTestimonialSubmissionHandler(deps);

    await handle({ ...baseRequest, data: buildInput({ id: 'testimonial-1' }) });
    await handle({ ...baseRequest, data: buildInput({ id: 'testimonial-2' }) });
    await handle({ ...baseRequest, data: buildInput({ id: 'testimonial-3' }) });

    await expect(
      handle({ ...baseRequest, data: buildInput({ id: 'testimonial-4' }) }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'rateLimited' });
    expect(await deps.repository.findById('testimonial-4')).toBeUndefined();
  });

  it('tracks rate limits per principal independently', async () => {
    const rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: 1,
      windowMs: TESTIMONIAL_SUBMISSION_RATE_LIMIT_WINDOW_MS,
    });
    const deps = buildDeps({ rateLimiter });
    const handle = createTestimonialSubmissionHandler(deps);

    await expect(handle(baseRequest)).resolves.toMatchObject({ kind: 'submitted' });
    await expect(
      handle({ ...baseRequest, data: buildInput({ id: 'testimonial-2' }) }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'rateLimited' });
    await expect(
      handle({
        ...baseRequest,
        principal: 'hashed-principal-2',
        data: buildInput({ id: 'testimonial-3' }),
      }),
    ).resolves.toMatchObject({ kind: 'submitted' });
  });
});
