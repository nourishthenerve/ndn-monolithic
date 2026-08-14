import type { ContentItem } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { createContentAuthoringHandler, type ContentAuthoringDeps } from './content-authoring.js';
import { ContentRepository, InMemoryContentStore } from './content-repository.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
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

function buildDeps(overrides: Partial<ContentAuthoringDeps> = {}) {
  const store = new InMemoryContentStore();
  const audit = new InMemoryAuditLog();
  const repository = new ContentRepository(store, audit, fixedClock);
  const source = new InMemoryFlagSource();
  source.set('content.authoring.enabled', true);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  const deps: ContentAuthoringDeps = {
    repository,
    flags,
    getAdminToken: async () => ADMIN_TOKEN,
    clock: fixedClock,
    ...overrides,
  };
  return { deps, repository, store, audit };
}

const validBody = {
  id: 'content-1',
  contentType: 'blog',
  status: 'draft',
  keywords: ['nutrition'],
  translations: { en: { title: 'Title', body: 'Body', excerpt: 'Excerpt' } },
};

describe('createContentAuthoringHandler — flag gating', () => {
  it('returns 404 when content.authoring.enabled is off, without checking the token', async () => {
    const { deps } = buildDeps();
    const source = new InMemoryFlagSource();
    source.set('content.authoring.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const handler = createContentAuthoringHandler({ ...deps, flags });

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content', headers: {}, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('createContentAuthoringHandler — admin token gate', () => {
  it('rejects a missing Authorization header with 401 and creates nothing', async () => {
    const { deps, repository } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content', headers: {}, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(await repository.findById('content-1')).toBeUndefined();
  });

  it('rejects a wrong token with 401 and creates nothing', async () => {
    const { deps, repository } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /content',
        headers: { authorization: 'Bearer wrong-token' },
        body: validBody,
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(await repository.findById('content-1')).toBeUndefined();
  });

  it('accepts the correct token', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 201 });
  });
});

describe('createContentAuthoringHandler — POST /content', () => {
  it('creates content and returns 201 with the created item', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 201 });
    const parsed = JSON.parse((result as { body: string }).body) as { item: ContentItem };
    expect(parsed.item.id).toBe('content-1');
    expect(parsed.item.keywords).toEqual(['nutrition', 'blog']);
  });

  it('rejects an invalid body with 400', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content', body: { id: 'content-1' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a translations object with an unsupported locale', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'POST /content',
        body: {
          ...validBody,
          translations: { fr: { title: 'T', body: 'B', excerpt: 'E' } },
        },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns 409 when the id already exists', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    await handler(
      fakeEvent({ routeKey: 'POST /content', body: validBody }),
      {} as never,
      undefined as never,
    );
    const second = await handler(
      fakeEvent({ routeKey: 'POST /content', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(second).toMatchObject({ statusCode: 409 });
  });
});

describe('createContentAuthoringHandler — PATCH /content/{id}', () => {
  it('updates translations and returns 200', async () => {
    const { deps, repository } = buildDeps();
    await repository.create('seed', validBody as never);
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'PATCH /content/{id}',
        pathParameters: { id: 'content-1' },
        body: { translations: { en: { title: 'New', body: 'New body', excerpt: 'New excerpt' } } },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const parsed = JSON.parse((result as { body: string }).body) as { item: ContentItem };
    expect(parsed.item.translations.en.title).toBe('New');
  });

  it('returns 404 for an id that does not exist', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({
        routeKey: 'PATCH /content/{id}',
        pathParameters: { id: 'missing' },
        body: { keywords: ['diet'] },
      }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('rejects an empty patch body with 400', async () => {
    const { deps, repository } = buildDeps();
    await repository.create('seed', validBody as never);
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'PATCH /content/{id}', pathParameters: { id: 'content-1' }, body: {} }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('createContentAuthoringHandler — publish/unpublish', () => {
  it('publish transitions status to published', async () => {
    const { deps, repository } = buildDeps();
    await repository.create('seed', { ...validBody, status: 'draft' } as never);
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content/{id}/publish', pathParameters: { id: 'content-1' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(await repository.findById('content-1')).toMatchObject({ status: 'published' });
  });

  it('unpublish transitions status to unpublished without deleting the row', async () => {
    const { deps, repository } = buildDeps();
    await repository.create('seed', { ...validBody, status: 'published' } as never);
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content/{id}/unpublish', pathParameters: { id: 'content-1' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    expect(await repository.findById('content-1')).toMatchObject({ status: 'unpublished' });
    expect(await repository.findPublishedByKeyword('nutrition')).toEqual([]);
  });

  it('publish returns 404 for an id that does not exist', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /content/{id}/publish', pathParameters: { id: 'missing' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});

describe('createContentAuthoringHandler — unknown route', () => {
  it('returns 404 for a routeKey it does not recognise', async () => {
    const { deps } = buildDeps();
    const handler = createContentAuthoringHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'DELETE /content/{id}' }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });
});
