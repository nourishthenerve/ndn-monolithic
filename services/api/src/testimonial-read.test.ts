// 2026-09-02: the public read, and what it is allowed to say.
//
// Most of this file is about the projection rather than the query, because
// the query was already right and the projection was the defect: this
// endpoint used to return `Testimonial` rows whole, on a public
// unauthenticated URL. That shipped a hashed contact detail, a status, two
// timestamps and a record id to anyone who asked — and once testimonials
// became patient-authored, that id is derived from the author's patient id.
import type { Testimonial } from '@ndn/shared-types';
import { MAX_FEATURED_TESTIMONIALS } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import {
  createTestimonialReadHandler,
  curatedTestimonials,
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

/** A published testimonial identifiable by its own quote — the fixtures below are about order, so the text is the label. */
function recordAt(label: string, createdAt: string): Testimonial {
  return {
    ...FULL_RECORD,
    id: label,
    authorPatientId: `pat-${label}`,
    quote: { en: label },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function quotesOf(body: string): (string | undefined)[] {
  return (JSON.parse(body) as { items: { quote: Record<string, string> }[] }).items.map(
    (item) => item.quote.en,
  );
}

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
          // Uncurated: the newest three carry a rank so the landing page
          // keeps showing what it showed before curation existed.
          featuredRank: 0,
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

  it('returns the newest first, whatever order the store lists ids in', async () => {
    const { deps, store } = buildDeps();
    // Created out of order on purpose: `listAllIds` is GSI2 order over
    // hashed ids, which is arbitrary — the owner read that as *"shown in
    // some random manner."*
    await store.create(recordAt('mid', '2026-03-01T00:00:00.000Z'));
    await store.create(recordAt('newest', '2026-08-01T00:00:00.000Z'));
    await store.create(recordAt('oldest', '2026-01-01T00:00:00.000Z'));
    const handler = createTestimonialReadHandler(deps);

    const result = (await handler(fakeEvent(), {} as never, undefined as never)) as {
      body: string;
    };
    expect(quotesOf(result.body)).toEqual(['newest', 'mid', 'oldest']);
  });

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

// 2026-09-07: the principal's picks, applied. The owner: *"I want the
// principal clinician to have option to cherry pick top rated testimonials
// on the landing page. However, when someone clicks Read more testimonials,
// there will be more cherry picked shown in chronological order with recent
// at the top."*
describe('curatedTestimonials', () => {
  const newest = recordAt('newest', '2026-08-01T00:00:00.000Z');
  const mid = recordAt('mid', '2026-03-01T00:00:00.000Z');
  const oldest = recordAt('oldest', '2026-01-01T00:00:00.000Z');
  const published = [newest, mid, oldest];

  function curation(featured: string[], listed: string[]) {
    return {
      featured,
      listed,
      status: 'active',
      created_at: '2026-09-07T00:00:00.000Z',
      updated_at: '2026-09-07T00:00:00.000Z',
    } as const;
  }

  it('shows everything, newest three ranked, when nobody has curated yet', () => {
    // The pre-curation site, unchanged. Shipping this feature must not
    // empty a live page before the principal has picked anything.
    const items = curatedTestimonials(published, undefined);

    expect(items.map((item) => item.quote.en)).toEqual(['newest', 'mid', 'oldest']);
    expect(items.map((item) => item.featuredRank)).toEqual([0, 1, 2]);
  });

  it('puts the landing page in the principal’s order and the page in chronological order', () => {
    // `oldest` first on the landing page — the point of cherry-picking is
    // that "top" is not "newest".
    const items = curatedTestimonials(published, curation(['oldest', 'newest'], ['mid']));

    expect(items.map((item) => item.quote.en)).toEqual(['newest', 'mid', 'oldest']);
    expect(items.find((item) => item.quote.en === 'oldest')?.featuredRank).toBe(0);
    expect(items.find((item) => item.quote.en === 'newest')?.featuredRank).toBe(1);
    expect(items.find((item) => item.quote.en === 'mid')?.featuredRank).toBeUndefined();
  });

  it('hides a published testimonial the principal picked for neither surface', () => {
    const items = curatedTestimonials(published, curation(['newest'], []));

    expect(items.map((item) => item.quote.en)).toEqual(['newest']);
  });

  it('shows nothing at all for a deliberately empty selection', () => {
    // Distinct from "never curated" directly above, and the distinction is
    // the whole reason `readCuration` returns `undefined` rather than an
    // empty record.
    expect(curatedTestimonials(published, curation([], []))).toEqual([]);
  });

  it('drops a pick whose testimonial is no longer published', () => {
    // A patient withdrew after being picked. Nothing the principal has to
    // notice, and nothing that can resurrect the quote.
    const items = curatedTestimonials([newest, oldest], curation(['mid', 'newest'], ['mid']));

    expect(items.map((item) => item.quote.en)).toEqual(['newest']);
    // And the rank closes up rather than leaving a hole at 0.
    expect(items[0]?.featuredRank).toBe(0);
  });

  it('caps the landing page and ignores a repeated pick', () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      recordAt(`q${index}`, `2026-0${index + 1}-01T00:00:00.000Z`),
    );
    const ids = many.map((item) => item.id);
    // The first id twice: a repeat is a data fault the read must survive,
    // not a second place on the landing page.
    const items = curatedTestimonials(
      [...many].sort((a, b) => b.created_at.localeCompare(a.created_at)),
      curation([...ids, ids[0] as string], []),
    );

    const ranked = items.filter((item) => item.featuredRank !== undefined);
    expect(ranked).toHaveLength(MAX_FEATURED_TESTIMONIALS);
    expect(ranked.map((item) => item.featuredRank).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('still says only the words, the credit and the rank', () => {
    const [item] = curatedTestimonials([FULL_RECORD], curation([FULL_RECORD.id], []));

    expect(Object.keys(item ?? {}).sort()).toEqual(['attribution', 'featuredRank', 'quote']);
  });
});
