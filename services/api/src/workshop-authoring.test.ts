import type { Workshop } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import {
  createWorkshopAuthoringHandler,
  type WorkshopAuthoringDeps,
} from './workshop-authoring.js';
import { InMemoryWorkshopStore, WorkshopRepository } from './workshop-repository.js';

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };
const ADMIN_TOKEN = 'test-admin-token';

function fakeEvent(overrides: {
  routeKey: string;
  pathParameters?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}) {
  return {
    routeKey: overrides.routeKey,
    pathParameters: overrides.pathParameters,
    headers: overrides.headers ?? { authorization: `Bearer ${ADMIN_TOKEN}` },
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: { requestId: 'req-1' },
  } as never;
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
    getAdminToken: async () => ADMIN_TOKEN,
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
  it('returns 404 when workshops.enabled is off, without checking the token', async () => {
    const { deps } = buildDeps();
    const source = new InMemoryFlagSource();
    source.set('workshops.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const handler = createWorkshopAuthoringHandler({ ...deps, flags });

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', headers: {}, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('createWorkshopAuthoringHandler — admin token gate', () => {
  it('rejects a missing Authorization header with 401 and creates nothing', async () => {
    const { deps, repository } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /workshops', headers: {}, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(await repository.findById('workshop-1')).toBeUndefined();
  });

  it('rejects a wrong token with 401 and creates nothing', async () => {
    const { deps, repository } = buildDeps();
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /workshops',
        headers: { authorization: 'Bearer wrong-token' },
        body: validBody,
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(await repository.findById('workshop-1')).toBeUndefined();
  });

  it('accepts the correct token', async () => {
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
    await repository.create('seed', validBody as never);
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'PATCH /workshops/{id}',
        pathParameters: { id: 'workshop-1' },
        body: { capacity: 30, posterKey: 'workshops/poster-1.jpg' },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const parsed = JSON.parse((result as { body: string }).body) as { item: Workshop };
    expect(parsed.item.capacity).toBe(30);
    expect(parsed.item.posterKey).toBe('workshops/poster-1.jpg');
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
    await repository.create('seed', validBody as never);
    const handler = createWorkshopAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'PATCH /workshops/{id}', pathParameters: { id: 'workshop-1' }, body: {} }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('createWorkshopAuthoringHandler — publish/cancel', () => {
  it('publish transitions status to published', async () => {
    const { deps, repository } = buildDeps();
    await repository.create('seed', { ...validBody, status: 'draft' } as never);
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
    await repository.create('seed', { ...validBody, status: 'published' } as never);
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
