import type { Workshop } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import type { RequestLogFields, RequestLogger } from './logger.js';
import {
  createWorkshopReadHandler,
  InMemoryWorkshopStore,
  WorkshopRepository,
  type CreateWorkshopInput,
} from './workshop-repository.js';

// TASK 2.1.3: repository writes take an `ActorContext` (audit.ts) rather
// than a bare actor string — who, with what role, on which request, from
// where. One fixture stands in for all four here.
const ACTOR = actorContext(
  { subjectId: 'admin-token', role: 'admin-token' },
  { requestId: 'req-workshop-1', sourceIp: '198.51.100.7' },
);

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };

function recordingLogger(): { logger: RequestLogger; calls: RequestLogFields[] } {
  const calls: RequestLogFields[] = [];
  return { logger: { logRequest: (fields) => calls.push(fields) }, calls };
}

function buildInput(overrides: Partial<CreateWorkshopInput> = {}): CreateWorkshopInput {
  return {
    id: 'workshop-1',
    status: 'published',
    dateTimeUtc: '2026-07-01T10:00:00.000Z',
    capacity: 20,
    priceMinorUnits: 2500,
    details: { en: { title: 'Balance & Falls Prevention', description: 'A hands-on workshop.' } },
    ...overrides,
  };
}

function buildRepository() {
  const store = new InMemoryWorkshopStore();
  const audit = new InMemoryAuditLog();
  const repository = new WorkshopRepository(store, audit, fixedClock);
  return { repository, store, audit };
}

describe('WorkshopRepository.create', () => {
  it('stamps created_at/updated_at and writes an audit entry', async () => {
    const { repository, audit } = buildRepository();
    const item = await repository.create(ACTOR, buildInput());

    expect(item.created_at).toBe('2026-06-01T00:00:00.000Z');
    expect(item.updated_at).toBe('2026-06-01T00:00:00.000Z');
    expect(audit.list()).toEqual([
      expect.objectContaining({
        actor: 'admin-token',
        action: 'create',
        entityType: 'Workshop',
        entityId: 'workshop-1',
      }),
    ]);
  });

  it('throws when a workshop with the same id already exists', async () => {
    const { repository } = buildRepository();
    await repository.create(ACTOR, buildInput());
    await expect(repository.create(ACTOR, buildInput())).rejects.toThrow(AppError);
  });

  it('has no method that removes a workshop', () => {
    const methodNames = Object.getOwnPropertyNames(WorkshopRepository.prototype);
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('remove');
  });
});

describe('WorkshopRepository.update', () => {
  it('patches schedule/capacity/price/poster/details, bumps updated_at, and writes an audit entry', async () => {
    const { repository, audit } = buildRepository();
    await repository.create(ACTOR, buildInput({ status: 'draft' }));

    const updated = await repository.update(ACTOR, 'workshop-1', {
      capacity: 30,
      posterKey: 'workshops/poster-1.jpg',
    });

    expect(updated.capacity).toBe(30);
    expect(updated.posterKey).toBe('workshops/poster-1.jpg');
    expect(updated.created_at).toBe('2026-06-01T00:00:00.000Z');
    expect(audit.list()).toContainEqual(
      expect.objectContaining({ actor: 'admin-token', action: 'update', entityId: 'workshop-1' }),
    );
  });

  it('never changes status', async () => {
    const { repository } = buildRepository();
    await repository.create(ACTOR, buildInput({ status: 'draft' }));
    const updated = await repository.update(ACTOR, 'workshop-1', { capacity: 5 });
    expect(updated.status).toBe('draft');
  });

  it('throws AppError for an id that does not exist', async () => {
    const { repository } = buildRepository();
    await expect(repository.update(ACTOR, 'missing', { capacity: 5 })).rejects.toThrow(AppError);
  });
});

describe('WorkshopRepository.publish/cancel', () => {
  it('publish transitions status to published and audits the transition', async () => {
    const { repository, audit } = buildRepository();
    await repository.create(ACTOR, buildInput({ status: 'draft' }));

    const published = await repository.publish(ACTOR, 'workshop-1');

    expect(published.status).toBe('published');
    expect(audit.list()).toContainEqual(
      expect.objectContaining({ actor: 'admin-token', action: 'publish', entityId: 'workshop-1' }),
    );
  });

  it('cancel transitions status to cancelled, never removing the row or its poster', async () => {
    const { repository, audit } = buildRepository();
    await repository.create(
      ACTOR,
      buildInput({ status: 'published', posterKey: 'workshops/poster-1.jpg' }),
    );

    const cancelled = await repository.cancel(ACTOR, 'workshop-1');

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.posterKey).toBe('workshops/poster-1.jpg');
    expect(await repository.findById('workshop-1')).toMatchObject({ status: 'cancelled' });
    expect(await repository.findPublishedUpcoming()).toEqual([]);
    expect(audit.list()).toContainEqual(
      expect.objectContaining({ actor: 'admin-token', action: 'cancel', entityId: 'workshop-1' }),
    );
  });

  it('throws AppError publishing an id that does not exist', async () => {
    const { repository } = buildRepository();
    await expect(repository.publish(ACTOR, 'missing')).rejects.toThrow(AppError);
  });
});

describe('WorkshopRepository.findPublishedUpcoming', () => {
  it('excludes draft and cancelled workshops', async () => {
    const { repository } = buildRepository();
    await repository.create(ACTOR, buildInput({ id: 'published-1', status: 'published' }));
    await repository.create(ACTOR, buildInput({ id: 'draft-1', status: 'draft' }));
    await repository.create(ACTOR, buildInput({ id: 'cancelled-1', status: 'published' }));
    await repository.cancel(ACTOR, 'cancelled-1');

    const found = await repository.findPublishedUpcoming();
    expect(found.map((item) => item.id)).toEqual(['published-1']);
  });

  it('excludes a published workshop whose dateTimeUtc has already passed', async () => {
    const { repository } = buildRepository();
    await repository.create(
      ACTOR,
      buildInput({ id: 'past-1', status: 'published', dateTimeUtc: '2026-05-01T00:00:00.000Z' }),
    );
    await repository.create(
      ACTOR,
      buildInput({ id: 'future-1', status: 'published', dateTimeUtc: '2026-07-01T00:00:00.000Z' }),
    );

    const found = await repository.findPublishedUpcoming();
    expect(found.map((item) => item.id)).toEqual(['future-1']);
  });

  it('a cancelled workshop never resurfaces once transitioned', async () => {
    const { repository } = buildRepository();
    await repository.create(ACTOR, buildInput({ id: 'workshop-1', status: 'published' }));
    await repository.cancel(ACTOR, 'workshop-1');

    expect(await repository.findPublishedUpcoming()).toEqual([]);
  });
});

describe('WorkshopRepository.findById', () => {
  it('returns draft and cancelled workshops by id — never hidden from a direct lookup', async () => {
    const { repository } = buildRepository();
    await repository.create(ACTOR, buildInput({ id: 'draft-1', status: 'draft' }));
    await repository.create(ACTOR, buildInput({ id: 'cancelled-1', status: 'published' }));
    await repository.cancel(ACTOR, 'cancelled-1');

    expect((await repository.findById('draft-1'))?.status).toBe('draft');
    expect((await repository.findById('cancelled-1'))?.status).toBe('cancelled');
  });

  it('returns undefined for an id that was never created', async () => {
    const { repository } = buildRepository();
    expect(await repository.findById('missing')).toBeUndefined();
  });
});

describe('createWorkshopReadHandler', () => {
  const fakeEvent = () => ({ requestContext: { requestId: 'req-1' } }) as never;

  function buildDeps(flagValue: boolean) {
    const source = new InMemoryFlagSource();
    source.set('workshops.enabled', flagValue);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const { repository } = buildRepository();
    return { repository, flags };
  }

  it('returns 404 when the flag is off', async () => {
    const { repository, flags } = buildDeps(false);
    const handler = createWorkshopReadHandler({ repository, flags, clock: fixedClock });

    const result = await handler(fakeEvent(), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns only published, upcoming workshops when the flag is on', async () => {
    const { repository, flags } = buildDeps(true);
    await repository.create(ACTOR, buildInput({ id: 'published-1', status: 'published' }));
    await repository.create(ACTOR, buildInput({ id: 'draft-1', status: 'draft' }));
    const handler = createWorkshopReadHandler({ repository, flags, clock: fixedClock });

    const result = await handler(fakeEvent(), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { items: Workshop[] };
    expect(body.items.map((item) => item.id)).toEqual(['published-1']);
  });

  it('logs one line per request', async () => {
    const { repository, flags } = buildDeps(true);
    const { logger, calls } = recordingLogger();
    const handler = createWorkshopReadHandler({ repository, flags, clock: fixedClock, logger });

    await handler(fakeEvent(), {} as never, undefined as never);
    expect(calls).toEqual([
      { requestId: 'req-1', route: '/workshops', statusCode: 200, durationMs: 0 },
    ]);
  });
});
