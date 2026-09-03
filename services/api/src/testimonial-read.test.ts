// 2026-09-02: the public read, and what it is allowed to say.
//
// Most of this file is about the projection rather than the query, because
// the query was already right and the projection was the defect: this
// endpoint used to return `Testimonial` rows whole, on a public
// unauthenticated URL. That shipped a hashed contact detail, a status, two
// timestamps and a record id to anyone who asked — and once testimonials
// became patient-authored, that id is derived from the author's patient id.
import type { Testimonial } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import {
  createTestimonialReadHandler,
  PUBLIC_READ_ROUTE,
  toPublicTestimonial,
} from './testimonial-read.js';
import { InMemoryTestimonialStore, TestimonialRepository } from './testimonial-repository.js';

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

function fakeEvent(routeKey = PUBLIC_READ_ROUTE): LambdaAuthorizerEvent {
  return {
    routeKey,
    // No authorizer context at all — this route is anonymous, and every
    // test here runs the way a stranger's browser would.
    requestContext: { requestId: 'req-1' },
  } as unknown as LambdaAuthorizerEvent;
}

function buildDeps() {
  const store = new InMemoryTestimonialStore();
  const repository = new TestimonialRepository(store, new InMemoryAuditLog(), fixedClock);
  return { deps: { repository, clock: fixedClock }, repository, store };
}

const FULL_RECORD: Testimonial = {
  id: 'a3f1c0de',
  status: 'published',
  authorPatientId: 'pat-1',
  quote: { en: 'The team got me walking again.' },
  attribution: { display: 'firstNameOnly', name: 'Jordan' },
  consent: {
    textVersion: '2026-09-02',
    consentedAt: '2026-06-01T00:00:00.000Z',
    submitterContactHash: 'legacy-hash',
  },
  created_at: '2026-06-01T00:00:00.000Z',
  updated_at: '2026-06-01T00:00:00.000Z',
};

describe('toPublicTestimonial', () => {
  it('says the words and the credit, and nothing else at all', () => {
    expect(toPublicTestimonial(FULL_RECORD)).toEqual({
      quote: { en: 'The team got me walking again.' },
      attribution: { display: 'firstNameOnly', name: 'Jordan' },
    });
  });

  it.each(['id', 'status', 'authorPatientId', 'consent', 'created_at', 'updated_at'])(
    'omits %s',
    (field) => {
      expect(Object.hasOwn(toPublicTestimonial(FULL_RECORD), field)).toBe(false);
    },
  );

  it('drops the name from an anonymous attribution rather than trusting it to be absent', () => {
    // A record can carry both — an author who typed a name and then chose
    // anonymity, or a legacy row. Publishing the name because it happened
    // to be there would break the one promise this field makes.
    const published = toPublicTestimonial({
      ...FULL_RECORD,
      attribution: { display: 'anonymous', name: 'Jordan' },
    });

    expect(published.attribution).toEqual({ display: 'anonymous' });
    expect(JSON.stringify(published)).not.toContain('Jordan');
  });
});

describe('GET /testimonials', () => {
  it('serves published testimonials to an anonymous caller', async () => {
    const { deps, store } = buildDeps();
    await store.create(FULL_RECORD);
    const handler = createTestimonialReadHandler(deps);

    const result = (await handler(fakeEvent(), {} as never, undefined as never)) as {
      statusCode: number;
      body: string;
    };

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({
      items: [
        {
          quote: { en: 'The team got me walking again.' },
          attribution: { display: 'firstNameOnly', name: 'Jordan' },
        },
      ],
    });
  });

  it('never leaks a patient id or a consent hash into the response body', async () => {
    const { deps, store } = buildDeps();
    await store.create(FULL_RECORD);
    const handler = createTestimonialReadHandler(deps);

    const result = (await handler(fakeEvent(), {} as never, undefined as never)) as {
      body: string;
    };

    // Asserted against the serialised body rather than the parsed object:
    // this is the string that actually crosses the boundary.
    expect(result.body).not.toContain('pat-1');
    expect(result.body).not.toContain('legacy-hash');
    expect(result.body).not.toContain('a3f1c0de');
  });

  it.each(['withdrawn', 'pending_review', 'rejected'] as const)(
    'excludes a %s testimonial',
    async (status) => {
      const { deps, store } = buildDeps();
      await store.create({ ...FULL_RECORD, status });
      const handler = createTestimonialReadHandler(deps);

      const result = (await handler(fakeEvent(), {} as never, undefined as never)) as {
        body: string;
      };
      expect(JSON.parse(result.body)).toEqual({ items: [] });
    },
  );

  it('answers 404 on any other route — the moderation paths are gone', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialReadHandler(deps);

    for (const routeKey of [
      'GET /testimonials/pending',
      'POST /testimonials/{id}/publish',
      'POST /testimonials/{id}/reject',
    ]) {
      const result = (await handler(fakeEvent(routeKey), {} as never, undefined as never)) as {
        statusCode: number;
      };
      expect(result.statusCode).toBe(404);
    }
  });
});
