import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import { InMemoryRateLimiter } from './rate-limiter.js';
import { InMemoryTestimonialStore, TestimonialRepository } from './testimonial-repository.js';
import {
  createTestimonialSubmissionHttpHandler,
  type TestimonialSubmissionHttpDeps,
} from './testimonial-submission-handler.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

function fakeEvent(overrides: { body?: unknown; sourceIp?: string }) {
  return {
    routeKey: 'POST /testimonials',
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: overrides.sourceIp ?? '203.0.113.1' },
    },
  } as never;
}

let idCounter = 0;

function buildDeps(overrides: Partial<TestimonialSubmissionHttpDeps> = {}) {
  const source = new InMemoryFlagSource();
  source.set('testimonials.submission.enabled', true);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  const verifyTurnstile = vi.fn().mockResolvedValue(true);
  const rateLimiter = new InMemoryRateLimiter({ clock: fixedClock, limit: 3, windowMs: 3_600_000 });
  const repository = new TestimonialRepository(
    new InMemoryTestimonialStore(),
    new InMemoryAuditLog(),
    fixedClock,
  );
  idCounter = 0;
  const deps: TestimonialSubmissionHttpDeps = {
    flags,
    verifyTurnstile,
    rateLimiter,
    repository,
    clock: fixedClock,
    generateId: () => `testimonial-${(idCounter += 1)}`,
    ...overrides,
  };
  return { deps, verifyTurnstile, repository };
}

const validBody = {
  quote: 'This service changed my recovery.',
  attributionDisplay: 'firstNameOnly',
  attributionName: 'Jordan',
  contactEmail: 'jordan@example.com',
  turnstileToken: 'a-real-token',
};

describe('createTestimonialSubmissionHttpHandler — flag gating', () => {
  it('returns 404 when testimonials.submission.enabled is off, without validating the body', async () => {
    const source = new InMemoryFlagSource();
    source.set('testimonials.submission.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const { deps, verifyTurnstile } = buildDeps({ flags });
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(fakeEvent({ body: {} }), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 404 });
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });
});

describe('createTestimonialSubmissionHttpHandler — body validation', () => {
  it('rejects a missing field with 400 before Turnstile is ever checked', async () => {
    const { deps, verifyTurnstile } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: { quote: 'Hi' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it('rejects a non-anonymous attribution missing a name with 400', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: { ...validBody, attributionName: undefined } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('accepts an anonymous attribution with no name', async () => {
    const { deps, repository } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(
      fakeEvent({
        body: { ...validBody, attributionDisplay: 'anonymous', attributionName: undefined },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 201 });
    expect((await repository.findById('testimonial-1'))?.attribution).toEqual({
      display: 'anonymous',
    });
  });

  it('rejects an invalid email with 400', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: { ...validBody, contactEmail: 'not-an-email' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a missing body with 400', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(fakeEvent({}), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('createTestimonialSubmissionHttpHandler — happy path', () => {
  it('submits as pending_review and returns 201, never storing the raw email', async () => {
    const { deps, repository } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 201 });

    const stored = await repository.findById('testimonial-1');
    expect(stored).toMatchObject({
      status: 'pending_review',
      quote: { en: 'This service changed my recovery.' },
      attribution: { display: 'firstNameOnly', name: 'Jordan' },
    });
    expect(stored?.consent.submitterContactHash).not.toContain('jordan@example.com');
    expect(JSON.stringify(stored)).not.toContain('jordan@example.com');
  });
});

describe('createTestimonialSubmissionHttpHandler — Turnstile gate', () => {
  it('returns 400 and never writes when Turnstile verification fails', async () => {
    const { deps, repository } = buildDeps({ verifyTurnstile: vi.fn().mockResolvedValue(false) });
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 400 });
    expect(await repository.findById('testimonial-1')).toBeUndefined();
  });
});

describe('createTestimonialSubmissionHttpHandler — rate limit gate', () => {
  it('returns 429 on a 4th submission within the window, from the same source IP', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    const fourth = await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);

    expect(fourth).toMatchObject({ statusCode: 429 });
  });

  it('rate limits independently per source IP', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.1' }),
      {} as never,
      undefined as never,
    );
    await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.1' }),
      {} as never,
      undefined as never,
    );
    await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.1' }),
      {} as never,
      undefined as never,
    );
    const otherIpResult = await handler(
      fakeEvent({ body: validBody, sourceIp: '198.51.100.7' }),
      {} as never,
      undefined as never,
    );

    expect(otherIpResult).toMatchObject({ statusCode: 201 });
  });

  it('never puts the raw source IP in the response body', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialSubmissionHttpHandler(deps);

    const result = (await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.42' }),
      {} as never,
      undefined as never,
    )) as { body: string };

    expect(result.body).not.toContain('203.0.113.42');
  });
});
