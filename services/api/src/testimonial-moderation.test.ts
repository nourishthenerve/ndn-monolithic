import type { Testimonial } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import {
  createTestimonialModerationHandler,
  type TestimonialModerationDeps,
} from './testimonial-moderation.js';
import {
  InMemoryTestimonialStore,
  TestimonialRepository,
  type SubmitTestimonialInput,
} from './testimonial-repository.js';

// TASK 2.1.3: the two actors these fixtures seed with. The handler under
// test builds its own from the request's principal (audit.ts's
// actorFromPrincipal).
const VISITOR = actorContext(
  { subjectId: 'visitor-1', role: 'public' },
  { requestId: 'req-submit-1', sourceIp: '198.51.100.7' },
);
const MODERATOR = actorContext(
  { subjectId: 'principal-sub', role: 'principal-clinician' },
  { requestId: 'req-moderate-1', sourceIp: '203.0.113.4' },
);

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const PRINCIPAL_CONTEXT = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};

const PATIENT_CONTEXT = {
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};

function fakeEvent(overrides: {
  routeKey: string;
  pathParameters?: Record<string, string>;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey,
    pathParameters: overrides.pathParameters,
    // TASK 2.1.3: `http.sourceIp` is part of every real API Gateway v2
    // event and is what the audit row's `where` is derived from
    // (audit.ts's requestOriginOf) — the fixture carries it because
    // the real event always does.
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : PRINCIPAL_CONTEXT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

function buildInput(overrides: Partial<SubmitTestimonialInput> = {}): SubmitTestimonialInput {
  return {
    id: 'testimonial-1',
    quote: { en: 'This service changed my recovery.' },
    attribution: { display: 'firstNameOnly', name: 'Jordan' },
    consent: { textVersion: '2026-08-14', submitterContactHash: 'hash-1' },
    ...overrides,
  };
}

function buildDeps(overrides: Partial<TestimonialModerationDeps> = {}) {
  const repository = new TestimonialRepository(
    new InMemoryTestimonialStore(),
    new InMemoryAuditLog(),
    fixedClock,
  );
  const source = new InMemoryFlagSource();
  source.set('testimonials.moderationQueue.enabled', true);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  const deps: TestimonialModerationDeps = {
    repository,
    flags,
    clock: fixedClock,
    ...overrides,
  };
  return { deps, repository };
}

describe('createTestimonialModerationHandler — GET /testimonials (public)', () => {
  it('returns only published testimonials, unauthenticated, no flag required', async () => {
    const { deps, repository } = buildDeps({
      flags: (() => {
        const source = new InMemoryFlagSource();
        source.set('testimonials.moderationQueue.enabled', false);
        return new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
      })(),
    });
    await repository.submit(VISITOR, buildInput({ id: 'published-1' }));
    await repository.submit(VISITOR, buildInput({ id: 'pending-1' }));
    await repository.publish(MODERATOR, 'published-1');
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'GET /testimonials', principal: undefined }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { items: Testimonial[] };
    expect(body.items.map((item) => item.id)).toEqual(['published-1']);
  });

  it('returns an empty array, not an error, when nothing is published yet', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'GET /testimonials', principal: undefined }),
      {} as never,
      undefined as never,
    );
    const body = JSON.parse((result as { body: string }).body) as { items: Testimonial[] };
    expect(body.items).toEqual([]);
  });
});

describe('createTestimonialModerationHandler — GET /testimonials/pending (moderation queue)', () => {
  it('returns 404 when testimonials.moderationQueue.enabled is off, without resolving a principal', async () => {
    const source = new InMemoryFlagSource();
    source.set('testimonials.moderationQueue.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const { deps } = buildDeps({ flags });
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'GET /testimonials/pending', principal: undefined }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('rejects a request with no verified principal, 401', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'GET /testimonials/pending', principal: undefined }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it('rejects a patient with 403', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'GET /testimonials/pending', principal: PATIENT_CONTEXT }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 403 });
  });

  it('returns only pending_review testimonials for a verified clinician', async () => {
    const { deps, repository } = buildDeps();
    await repository.submit(VISITOR, buildInput({ id: 'published-1' }));
    await repository.submit(VISITOR, buildInput({ id: 'pending-1' }));
    await repository.publish(MODERATOR, 'published-1');
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'GET /testimonials/pending' }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { items: Testimonial[] };
    expect(body.items.map((item) => item.id)).toEqual(['pending-1']);
  });
});

describe('createTestimonialModerationHandler — POST /testimonials/{id}/publish', () => {
  it('returns 404 when the flag is off', async () => {
    const source = new InMemoryFlagSource();
    source.set('testimonials.moderationQueue.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const { deps } = buildDeps({ flags });
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /testimonials/{id}/publish',
        pathParameters: { id: 'testimonial-1' },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('rejects a patient with 403 and publishes nothing', async () => {
    const { deps, repository } = buildDeps();
    await repository.submit(VISITOR, buildInput());
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /testimonials/{id}/publish',
        pathParameters: { id: 'testimonial-1' },
        principal: PATIENT_CONTEXT,
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 403 });
    expect(await repository.findById('testimonial-1')).toMatchObject({ status: 'pending_review' });
  });

  it('transitions status to published and never touches consent', async () => {
    const { deps, repository } = buildDeps();
    const submitted = await repository.submit(VISITOR, buildInput());
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /testimonials/{id}/publish',
        pathParameters: { id: 'testimonial-1' },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const stored = await repository.findById('testimonial-1');
    expect(stored?.status).toBe('published');
    expect(stored?.consent).toEqual(submitted.consent);
  });

  it('returns 404 for an id that does not exist', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /testimonials/{id}/publish', pathParameters: { id: 'missing' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('createTestimonialModerationHandler — POST /testimonials/{id}/reject', () => {
  it('transitions status to rejected without deleting the row', async () => {
    const { deps, repository } = buildDeps();
    await repository.submit(VISITOR, buildInput());
    const handler = createTestimonialModerationHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /testimonials/{id}/reject',
        pathParameters: { id: 'testimonial-1' },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(await repository.findById('testimonial-1')).toMatchObject({ status: 'rejected' });
    expect(await repository.findPublished()).toEqual([]);
  });
});
