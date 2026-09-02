// 2026-09-02: `GET|PUT|DELETE /testimonials/mine`.
//
// The assertions worth having here are about who is refused, because the
// owner's requirement is stated as a denial: *"submit a testimonial
// shouldn't be available for public and all kinds of clinicians."* That
// includes the principal, which reverses the "principal can do anything"
// rule this codebase holds everywhere else — so it is asserted by name
// rather than left to the matrix's own table test to imply.
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import {
  createTestimonialAuthoringHandler,
  LIST_ROUTE,
  UPSERT_ROUTE,
  WITHDRAW_ROUTE,
} from './testimonial-authoring.js';
import { InMemoryTestimonialStore, TestimonialRepository } from './testimonial-repository.js';

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const PATIENT = {
  subjectId: 'pat-1-sub',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};
const OTHER_PATIENT = {
  subjectId: 'pat-2-sub',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-2',
};
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
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : PATIENT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

function buildDeps(flagValue = true) {
  const store = new InMemoryTestimonialStore();
  const audit = new InMemoryAuditLog();
  const repository = new TestimonialRepository(store, audit, fixedClock);
  const source = new InMemoryFlagSource();
  source.set('testimonials.enabled', flagValue);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  return { deps: { repository, flags, clock: fixedClock }, repository, store, audit };
}

const validBody = {
  quote: 'The team got me walking again.',
  attribution: { display: 'firstNameOnly', name: 'Jordan' },
};

async function invoke(
  handler: ReturnType<typeof createTestimonialAuthoringHandler>,
  event: LambdaAuthorizerEvent,
) {
  return (await handler(event, {} as never, undefined as never)) as {
    statusCode: number;
    body: string;
  };
}

describe('flag gating', () => {
  it('returns 404 when testimonials.enabled is off, before looking at the principal', async () => {
    const { deps } = buildDeps(false);
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody, principal: undefined }),
    );
    expect(result.statusCode).toBe(404);
  });
});

describe('who may write a testimonial', () => {
  it('rejects a request with no verified principal', async () => {
    const { deps, store } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody, principal: undefined }),
    );
    expect(result.statusCode).toBe(401);
    expect(await store.listAllIds()).toEqual([]);
  });

  // Stated as its own case because it is the surprising one. Every other
  // row in the matrix grants the principal everything; this one grants
  // them nothing, and it is meant to.
  it('rejects the principal clinician — a testimonial is the patient’s own words', async () => {
    const { deps, store } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody, principal: PRINCIPAL }),
    );
    expect(result.statusCode).toBe(403);
    expect(await store.listAllIds()).toEqual([]);
  });

  it.each([
    ['a sub-clinician', SUB_CLINICIAN],
    ['a helpdesk account', HELPDESK],
    ['a visitor account', VISITOR],
  ])('rejects %s on every route', async (_label, principal) => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    for (const routeKey of [LIST_ROUTE, UPSERT_ROUTE, WITHDRAW_ROUTE]) {
      const result = await invoke(handler, fakeEvent({ routeKey, body: validBody, principal }));
      expect(result.statusCode).toBe(403);
    }
  });

  it('accepts a patient', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));
    expect(result.statusCode).toBe(200);
  });
});

describe('PUT /testimonials/mine', () => {
  it('publishes immediately, with no review step', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));
    const parsed = JSON.parse(result.body) as { item: { status: string; quote: { en: string } } };

    expect(parsed.item.status).toBe('published');
    expect(parsed.item.quote.en).toBe('The team got me walking again.');
  });

  it('is an update the second time, never a second testimonial', async () => {
    const { deps, store } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));
    await invoke(
      handler,
      fakeEvent({ routeKey: UPSERT_ROUTE, body: { ...validBody, quote: 'Edited.' } }),
    );

    expect(await store.listAllIds()).toHaveLength(1);
  });

  it('writes to the caller’s own record — there is no id to name someone else’s', async () => {
    const { deps, repository } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));
    await invoke(
      handler,
      fakeEvent({
        routeKey: UPSERT_ROUTE,
        body: { ...validBody, quote: 'Not yours.' },
        principal: OTHER_PATIENT,
      }),
    );

    expect((await repository.findForPatient('pat-1'))?.quote.en).toBe(
      'The team got me walking again.',
    );
    expect((await repository.findForPatient('pat-2'))?.quote.en).toBe('Not yours.');
  });

  it.each([
    ['an empty quote', { quote: '', attribution: { display: 'anonymous' } }],
    ['a missing attribution', { quote: 'Fine.' }],
    ['a named display with no name', { quote: 'Fine.', attribution: { display: 'full' } }],
    ['an unknown display', { quote: 'Fine.', attribution: { display: 'initials' } }],
  ])('rejects %s with 400', async (_label, body) => {
    const { deps, store } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body }));
    expect(result.statusCode).toBe(400);
    expect(await store.listAllIds()).toEqual([]);
  });

  it('accepts an anonymous attribution with no name', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({
        routeKey: UPSERT_ROUTE,
        body: { quote: 'Rather not be named.', attribution: { display: 'anonymous' } },
      }),
    );
    expect(result.statusCode).toBe(200);
  });
});

describe('GET /testimonials/mine', () => {
  it('answers 200 with a null item before the patient has written one', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE }));

    // Not a 404: "you have not written one" is this resource's ordinary
    // state, and the account page renders the same empty form either way.
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body)).toEqual({ item: null });
  });

  it('returns the caller’s own testimonial, never another patient’s', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);
    await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));

    const mine = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE }));
    const theirs = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, principal: OTHER_PATIENT }),
    );

    expect((JSON.parse(mine.body) as { item: { quote: { en: string } } }).item.quote.en).toBe(
      'The team got me walking again.',
    );
    expect(JSON.parse(theirs.body)).toEqual({ item: null });
  });

  it('returns a withdrawn testimonial too, so the patient can put it back', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);
    await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));
    await invoke(handler, fakeEvent({ routeKey: WITHDRAW_ROUTE }));

    const result = await invoke(handler, fakeEvent({ routeKey: LIST_ROUTE }));
    expect((JSON.parse(result.body) as { item: { status: string } }).item.status).toBe('withdrawn');
  });
});

describe('DELETE /testimonials/mine', () => {
  it('withdraws the caller’s testimonial', async () => {
    const { deps, repository } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);
    await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));

    const result = await invoke(handler, fakeEvent({ routeKey: WITHDRAW_ROUTE }));

    expect(result.statusCode).toBe(200);
    expect(await repository.findPublished()).toEqual([]);
  });

  it('answers 404 when there is nothing to withdraw', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(handler, fakeEvent({ routeKey: WITHDRAW_ROUTE }));
    expect(result.statusCode).toBe(404);
  });

  it('cannot reach another patient’s testimonial', async () => {
    const { deps, repository } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);
    await invoke(handler, fakeEvent({ routeKey: UPSERT_ROUTE, body: validBody }));

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: WITHDRAW_ROUTE, principal: OTHER_PATIENT }),
    );

    expect(result.statusCode).toBe(404);
    expect((await repository.findForPatient('pat-1'))?.status).toBe('published');
  });
});

describe('an unknown route', () => {
  it('answers 404 rather than falling through to a default', async () => {
    const { deps } = buildDeps();
    const handler = createTestimonialAuthoringHandler(deps);

    const result = await invoke(
      handler,
      fakeEvent({ routeKey: 'POST /testimonials/{id}/publish', body: validBody }),
    );
    expect(result.statusCode).toBe(404);
  });
});
