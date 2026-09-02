import type { Workshop } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import {
  createWorkshopAuthoringHandler,
  type WorkshopAuthoringDeps,
} from './workshop-authoring.js';
import { InMemoryWorkshopStore, WorkshopRepository } from './workshop-repository.js';

// TASK 2.1.3: the seeding actor for fixtures these tests set up directly
// through the repository. The handler under test builds its own
// `ActorContext` from the request's principal (audit.ts's actorFromPrincipal).
const SEED_ACTOR = actorContext(
  { subjectId: 'seed', role: 'principal-clinician' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

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
  body?: unknown;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey,
    pathParameters: overrides.pathParameters,
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
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

function buildDeps(overrides: Partial<WorkshopAuthoringDeps> = {}) {
  const store = new InMemoryWorkshopStore();
  const audit = new InMemoryAuditLog();
  const repository = new WorkshopRepository(store, audit, fixedClock);
  const source = new InMemoryFlagSource();
  source.set('workshops.enabled', true);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  const deps: WorkshopAuthoringDeps = {
    repository,
    flags,
    clock: fixedClock,
    ...overrides,
  };
  return { deps, repository, store, audit };
}

const validBody = {
  id: 'workshop-1',
  status: 'draft',
  dateTimeUtc: '2026-07-01T10:00:00.000Z',
  capacity: 20,
  priceMinorUnits: 2500,
  details: { en: { title: 'Balance & Falls Prevention', description: 'A hands-on workshop.' } },
};

describe('createWorkshopAuthoringHandler — flag gating', () => {
  it('returns 404 when workshops.enabled is off, without checking the principal', async () => {
    const { deps } = buildDeps();
    const source = new InMemoryFlagSource();
    source.set('workshops.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const handler = createWorkshopAuthoringHandler({ ...deps, flags });

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', principal: undefined, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('createWorkshopAuthoringHandler — authentication and authorisation', () => {
  it('rejects a request with no verified principal, 401, and creates nothing', async () => {
    const { deps, repository } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', principal: undefined, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(await repository.findById('workshop-1')).toBeUndefined();
  });

  it('rejects a patient with 403 and creates nothing', async () => {
    const { deps, repository } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', principal: PATIENT_CONTEXT, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 403 });
    expect(await repository.findById('workshop-1')).toBeUndefined();
  });

  it('accepts the principal clinician', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 201 });
  });
});

describe('createWorkshopAuthoringHandler — POST /workshops', () => {
  it('creates a workshop and returns 201 with the created item', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 201 });
    const parsed = JSON.parse((result as { body: string }).body) as { item: Workshop };
    expect(parsed.item.id).toBe('workshop-1');
    expect(parsed.item.capacity).toBe(20);
  });

  it('rejects an invalid body with 400', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', body: { id: 'workshop-1' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a negative priceMinorUnits with 400', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', body: { ...validBody, priceMinorUnits: -1 } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a non-integer priceMinorUnits with 400', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', body: { ...validBody, priceMinorUnits: 25.5 } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a details object with an unsupported locale', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /workshops',
        body: { ...validBody, details: { fr: { title: 'T', description: 'D' } } },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 409 when the id already exists', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    await handler(
      fakeEvent({ routeKey: 'POST /workshops', body: validBody }),
      {} as never,
      undefined as never,
    );
    const second = await handler(
      fakeEvent({ routeKey: 'POST /workshops', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(second).toMatchObject({ statusCode: 409 });
  });
});

describe('createWorkshopAuthoringHandler — PATCH /workshops/{id}', () => {
  it('updates capacity/posterKey and returns 200', async () => {
    const { deps, repository } = buildDeps();
    await repository.create(SEED_ACTOR, validBody as never);
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'PATCH /workshops/{id}',
        pathParameters: { id: 'workshop-1' },
        body: { capacity: 30, posterKey: 'media/workshops/poster-1.jpg' },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const parsed = JSON.parse((result as { body: string }).body) as { item: Workshop };
    expect(parsed.item.capacity).toBe(30);
    expect(parsed.item.posterKey).toBe('media/workshops/poster-1.jpg');
  });

  // 2026-09-02: `posterKey` was `z.string().min(1)`, so any string reached
  // the record and then a public `<img src>`. The only legitimate source is
  // `POST /workshops/media-upload-url`, which issues keys under
  // `media/workshops/`; everything else is a caller composing part of a URL
  // on a public page.
  it.each([
    ['assessments/pat-1/scan.pdf', 'names a private prefix in the same bucket'],
    ['media/workshops/../../assessments/pat-1/scan.pdf', 'walks out of the prefix'],
    ['media/content/hero.png', 'belongs to the other surface'],
    ['https://evil.example/x.jpg', 'is not a key at all'],
  ])('refuses a posterKey that %s', async (posterKey) => {
    const { deps, repository } = buildDeps();
    await repository.create(SEED_ACTOR, validBody as never);
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'PATCH /workshops/{id}',
        pathParameters: { id: 'workshop-1' },
        body: { posterKey },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 404 for an id that does not exist', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'PATCH /workshops/{id}',
        pathParameters: { id: 'missing' },
        body: { capacity: 5 },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('rejects an empty patch body with 400', async () => {
    const { deps, repository } = buildDeps();
    await repository.create(SEED_ACTOR, validBody as never);
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'PATCH /workshops/{id}',
        pathParameters: { id: 'workshop-1' },
        body: {},
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('createWorkshopAuthoringHandler — publish/cancel', () => {
  it('publish transitions status to published', async () => {
    const { deps, repository } = buildDeps();
    await repository.create(SEED_ACTOR, { ...validBody, status: 'draft' } as never);
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops/{id}/publish', pathParameters: { id: 'workshop-1' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(await repository.findById('workshop-1')).toMatchObject({ status: 'published' });
  });

  it('cancel transitions status to cancelled without deleting the row', async () => {
    const { deps, repository } = buildDeps();
    await repository.create(SEED_ACTOR, { ...validBody, status: 'published' } as never);
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops/{id}/cancel', pathParameters: { id: 'workshop-1' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(await repository.findById('workshop-1')).toMatchObject({ status: 'cancelled' });
    expect(await repository.findPublishedUpcoming()).toEqual([]);
  });

  it('publish returns 404 for an id that does not exist', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops/{id}/publish', pathParameters: { id: 'missing' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('createWorkshopAuthoringHandler — unknown route', () => {
  it('returns 404 for a routeKey it does not recognise', async () => {
    const { deps } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'DELETE /workshops/{id}' }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});
