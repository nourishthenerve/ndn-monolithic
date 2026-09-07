// 2026-09-07: `GET|PUT /testimonials/curation`.
//
// Two things are asserted here that no other file can assert, and they pull
// in opposite directions:
//
//   * the principal *may* choose what the site shows — the whole feature;
//   * the principal *may not* touch a testimonial — the 2026-09-02 rule
//     this feature had to be built around rather than through.
//
// The second is the one worth naming by test. `authz.test.ts` proves the
// `Testimonial (own)` row still denies every clinician column, but a row in
// a table cannot prove that *these* routes leave the words alone. The
// "saving picks leaves every testimonial byte-for-byte unchanged" test is
// what does.
import type { Testimonial } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import {
  createTestimonialCurationHandler,
  READ_ROUTE,
  SAVE_ROUTE,
} from './testimonial-curation.js';
import { InMemoryTestimonialStore, TestimonialRepository } from './testimonial-repository.js';

const fixedClock: Clock = { now: () => new Date('2026-09-07T00:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const PRINCIPAL = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};
const SUB_CLINICIAN = {
  subjectId: 'clin-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'clin-1',
};
const HELPDESK = {
  subjectId: 'help-1',
  role: 'helpdesk',
  accountStatus: 'active',
  clinicianId: 'help-1',
};
const VISITOR = {
  subjectId: 'vis-1',
  role: 'visitor',
  accountStatus: 'active',
  clinicianId: 'vis-1',
};
const PATIENT = {
  subjectId: 'pat-1-sub',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};

function fakeEvent(overrides: {
  routeKey: string;
  body?: unknown;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey,
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : PRINCIPAL },
    },
  } as unknown as LambdaAuthorizerEvent;
}

function testimonial(id: string, createdAt: string): Testimonial {
  return {
    id,
    status: 'published',
    authorPatientId: `pat-${id}`,
    quote: { en: `quote ${id}` },
    attribution: { display: 'firstNameOnly', name: id },
    consent: { textVersion: '2026-09-02', consentedAt: createdAt },
    created_at: createdAt,
    updated_at: createdAt,
  };
}

const NEWEST = testimonial('newest', '2026-08-01T00:00:00.000Z');
const MID = testimonial('mid', '2026-03-01T00:00:00.000Z');
const OLDEST = testimonial('oldest', '2026-01-01T00:00:00.000Z');

function buildDeps(flagValue = true) {
  const store = new InMemoryTestimonialStore();
  const audit = new InMemoryAuditLog();
  const repository = new TestimonialRepository(store, audit, fixedClock);
  const source = new InMemoryFlagSource();
  source.set('testimonials.enabled', flagValue);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  return { deps: { repository, flags, clock: fixedClock }, repository, store, audit };
}

async function invoke(
  handler: ReturnType<typeof createTestimonialCurationHandler>,
  event: LambdaAuthorizerEvent,
) {
  return (await handler(event, {} as never, undefined as never)) as {
    statusCode: number;
    body: string;
  };
}

async function seeded(flagValue = true) {
  const built = buildDeps(flagValue);
  for (const item of [MID, NEWEST, OLDEST]) {
    await built.store.create(item);
  }
  return built;
}

describe('who may curate', () => {
  it.each([
    ['a sub-clinician', SUB_CLINICIAN],
    ['a helpdesk account', HELPDESK],
    ['a visitor', VISITOR],
    // A patient least of all: they choose whether their words are
    // published, never whether the practice puts them on its homepage.
    ['a patient', PATIENT],
  ])('refuses %s on both routes', async (_label, who) => {
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    for (const routeKey of [READ_ROUTE, SAVE_ROUTE]) {
      const result = await invoke(
        handler,
        fakeEvent({ routeKey, principal: who, body: { featured: [], listed: [] } }),
      );
      expect(result.statusCode).toBe(403);
    }
  });

  it('refuses an unauthenticated caller', async () => {
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: READ_ROUTE, principal: undefined }),
    );
    expect(result.statusCode).toBe(401);
  });

  it('returns 404 when testimonials.enabled is off, before looking at the principal', async () => {
    const { deps } = await seeded(false);
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(handler, fakeEvent({ routeKey: READ_ROUTE }));
    expect(result.statusCode).toBe(404);
  });
});

describe('GET /testimonials/curation', () => {
  it('lists every published testimonial newest first, with its current placement', async () => {
    const { deps, repository } = await seeded();
    await repository.saveCuration(
      { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
      { featured: ['oldest'], listed: ['mid'] },
    );
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(handler, fakeEvent({ routeKey: READ_ROUTE }));
    const body = JSON.parse(result.body) as {
      items: { id: string; placement: string; featuredRank?: number }[];
      curated: boolean;
    };

    expect(result.statusCode).toBe(200);
    expect(body.items.map((item) => item.id)).toEqual(['newest', 'mid', 'oldest']);
    expect(body.items.map((item) => item.placement)).toEqual(['hidden', 'page', 'landing']);
    expect(body.items.find((item) => item.id === 'oldest')?.featuredRank).toBe(0);
    expect(body.curated).toBe(true);
  });

  it('says nobody has curated yet, rather than reporting everything hidden', async () => {
    // The screen needs the difference: with `curated: false` every one of
    // these is on the site right now, despite reading `hidden`.
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const body = JSON.parse((await invoke(handler, fakeEvent({ routeKey: READ_ROUTE }))).body) as {
      curated: boolean;
      items: { placement: string }[];
    };

    expect(body.curated).toBe(false);
    expect(body.items.every((item) => item.placement === 'hidden')).toBe(true);
  });

  it('shows the principal the words, so they can tell which is which', async () => {
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const body = JSON.parse((await invoke(handler, fakeEvent({ routeKey: READ_ROUTE }))).body) as {
      items: { quote: Record<string, string>; publishedAt: string }[];
    };

    expect(body.items[0]?.quote.en).toBe('quote newest');
    expect(body.items[0]?.publishedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('never shows an unpublished testimonial — a withdrawn one cannot be re-promoted', async () => {
    const { deps, store } = await seeded();
    await store.update({ ...NEWEST, status: 'withdrawn' });
    const handler = createTestimonialCurationHandler(deps);

    const body = JSON.parse((await invoke(handler, fakeEvent({ routeKey: READ_ROUTE }))).body) as {
      items: { id: string }[];
    };

    expect(body.items.map((item) => item.id)).toEqual(['mid', 'oldest']);
  });
});

describe('PUT /testimonials/curation', () => {
  it('saves the picks and answers with the screen’s new state', async () => {
    const { deps, repository } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: SAVE_ROUTE, body: { featured: ['oldest', 'newest'], listed: ['mid'] } }),
    );

    expect(result.statusCode).toBe(200);
    expect(await repository.readCuration()).toMatchObject({
      featured: ['oldest', 'newest'],
      listed: ['mid'],
    });
    const body = JSON.parse(result.body) as { items: { id: string; featuredRank?: number }[] };
    expect(body.items.find((item) => item.id === 'oldest')?.featuredRank).toBe(0);
  });

  it('leaves every testimonial exactly as it was', async () => {
    // The point of the whole design. A principal decides where a quote
    // appears and can change nothing about the quote itself — not its
    // words, not its credit, not its status, not its consent.
    const { deps, store } = await seeded();
    const before = await Promise.all(['newest', 'mid', 'oldest'].map((id) => store.get(id)));
    const handler = createTestimonialCurationHandler(deps);

    await invoke(
      handler,
      fakeEvent({ routeKey: SAVE_ROUTE, body: { featured: ['newest'], listed: [] } }),
    );

    const after = await Promise.all(['newest', 'mid', 'oldest'].map((id) => store.get(id)));
    expect(after).toEqual(before);
  });

  it('audits the save against the curation record, never against a testimonial', async () => {
    const { deps, audit } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    await invoke(
      handler,
      fakeEvent({ routeKey: SAVE_ROUTE, body: { featured: ['newest'], listed: [] } }),
    );

    expect(audit.list()).toHaveLength(1);
    expect(audit.list()[0]).toMatchObject({
      actor: 'principal-sub',
      action: 'create',
      entityType: 'TestimonialCuration',
      entityId: 'site',
    });
    // Naming a testimonial here would record the principal as having
    // "updated" someone's words, which is exactly what did not happen.
    expect(JSON.stringify(audit.list())).not.toContain('newest');
  });

  it('records the second save as an update rather than a second create', async () => {
    const { deps, audit } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    for (const featured of [['newest'], ['mid']]) {
      await invoke(handler, fakeEvent({ routeKey: SAVE_ROUTE, body: { featured, listed: [] } }));
    }

    expect(audit.list().map((event) => event.action)).toEqual(['create', 'update']);
  });

  it('rejects a pick that names a testimonial nobody published', async () => {
    const { deps, repository } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: SAVE_ROUTE, body: { featured: ['made-up'], listed: [] } }),
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ error: 'UNKNOWN_TESTIMONIAL' });
    // Nothing was written — a rejected save leaves the site as it was.
    expect(await repository.readCuration()).toBeUndefined();
  });

  it('rejects a testimonial named on both surfaces', async () => {
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: SAVE_ROUTE, body: { featured: ['newest'], listed: ['newest'] } }),
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ error: 'DUPLICATE_TESTIMONIAL' });
  });

  it('rejects the same testimonial twice on the landing page', async () => {
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: SAVE_ROUTE, body: { featured: ['newest', 'newest'], listed: [] } }),
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ error: 'DUPLICATE_TESTIMONIAL' });
  });

  it('rejects more landing-page picks than the homepage can hold', async () => {
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({
        routeKey: SAVE_ROUTE,
        body: { featured: Array.from({ length: 7 }, (_, i) => `q${i}`), listed: [] },
      }),
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toMatchObject({ error: 'INVALID_BODY' });
  });

  it('rejects a body that is not two arrays of ids', async () => {
    const { deps } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    for (const body of [undefined, {}, { featured: 'newest', listed: [] }, { featured: [1] }]) {
      const result = await invoke(handler, fakeEvent({ routeKey: SAVE_ROUTE, body }));
      expect(result.statusCode).toBe(400);
    }
  });

  it('accepts an empty selection — a deliberately blank set of surfaces', async () => {
    const { deps, repository } = await seeded();
    const handler = createTestimonialCurationHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: SAVE_ROUTE, body: { featured: [], listed: [] } }),
    );

    expect(result.statusCode).toBe(200);
    // The record now exists, which is what turns "nobody has picked" into
    // "the principal picked nothing" — see `readCuration`.
    expect(await repository.readCuration()).toMatchObject({ featured: [], listed: [] });
  });
});

it('answers 404 on any other route', async () => {
  const { deps } = await seeded();
  const handler = createTestimonialCurationHandler(deps);

  const result = await invoke(handler, fakeEvent({ routeKey: 'DELETE /testimonials/curation' }));
  expect(result.statusCode).toBe(404);
});
