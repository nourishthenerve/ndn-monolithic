import type { ContentItem } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import {
  ContentRepository,
  createContentReadHandler,
  InMemoryContentStore,
  type CreateContentInput,
} from './content-repository.js';
import { AppError } from './errors.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import type { RequestLogFields, RequestLogger } from './logger.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const fakeEvent = (queryStringParameters?: Record<string, string>) =>
  ({
    requestContext: { requestId: 'req-1' },
    queryStringParameters,
  }) as never;

function recordingLogger(): { logger: RequestLogger; calls: RequestLogFields[] } {
  const calls: RequestLogFields[] = [];
  return { logger: { logRequest: (fields) => calls.push(fields) }, calls };
}

function buildInput(overrides: Partial<CreateContentInput> = {}): CreateContentInput {
  return {
    id: 'content-1',
    contentType: 'blog',
    status: 'published',
    keywords: ['nutrition'],
    translations: { en: { title: 'Title', body: 'Body', excerpt: 'Excerpt' } },
    ...overrides,
  };
}

function buildRepository() {
  const store = new InMemoryContentStore();
  const audit = new InMemoryAuditLog();
  const repository = new ContentRepository(store, audit, fixedClock);
  return { repository, store, audit };
}

describe('ContentRepository.create', () => {
  it('stamps created_at/updated_at and writes an audit entry', async () => {
    const { repository, audit } = buildRepository();
    const item = await repository.create('editor-1', buildInput());

    expect(item.created_at).toBe('2026-01-01T00:00:00.000Z');
    expect(item.updated_at).toBe('2026-01-01T00:00:00.000Z');
    expect(audit.list()).toEqual([
      expect.objectContaining({
        actor: 'editor-1',
        action: 'create',
        entityType: 'Content',
        entityId: 'content-1',
      }),
    ]);
  });

  it('throws when a content item with the same id already exists', async () => {
    const { repository } = buildRepository();
    await repository.create('editor-1', buildInput());
    await expect(repository.create('editor-1', buildInput())).rejects.toThrow(AppError);
  });

  it('is discoverable by every one of its keywords', async () => {
    const { repository } = buildRepository();
    await repository.create(
      'editor-1',
      buildInput({ keywords: ['nutrition', 'diabetes', 'recipes'] }),
    );

    for (const keyword of ['nutrition', 'diabetes', 'recipes']) {
      const found = await repository.findPublishedByKeyword(keyword);
      expect(found.map((item) => item.id)).toEqual(['content-1']);
    }
  });

  it('has no method that removes a content item', () => {
    const methodNames = Object.getOwnPropertyNames(ContentRepository.prototype);
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('remove');
  });
});

describe('ContentRepository.findById', () => {
  it('returns unpublished and draft content by id — never deleted, never hidden from a direct lookup', async () => {
    const { repository } = buildRepository();
    await repository.create('editor-1', buildInput({ id: 'draft-1', status: 'draft' }));
    await repository.create('editor-1', buildInput({ id: 'unpub-1', status: 'unpublished' }));

    expect((await repository.findById('draft-1'))?.status).toBe('draft');
    expect((await repository.findById('unpub-1'))?.status).toBe('unpublished');
  });

  it('returns undefined for an id that was never created', async () => {
    const { repository } = buildRepository();
    expect(await repository.findById('missing')).toBeUndefined();
  });
});

describe('ContentRepository.findPublishedByKeyword', () => {
  it('excludes draft and unpublished content sharing the same keyword', async () => {
    const { repository } = buildRepository();
    await repository.create(
      'editor-1',
      buildInput({ id: 'published-1', status: 'published', keywords: ['diet'] }),
    );
    await repository.create(
      'editor-1',
      buildInput({ id: 'draft-1', status: 'draft', keywords: ['diet'] }),
    );
    await repository.create(
      'editor-1',
      buildInput({ id: 'unpub-1', status: 'unpublished', keywords: ['diet'] }),
    );

    const found = await repository.findPublishedByKeyword('diet');
    expect(found.map((item) => item.id)).toEqual(['published-1']);
  });

  it('returns an empty array for a keyword nothing is tagged with', async () => {
    const { repository } = buildRepository();
    expect(await repository.findPublishedByKeyword('nonexistent')).toEqual([]);
  });
});

describe('createContentReadHandler', () => {
  function buildDeps(flagValue: boolean) {
    const source = new InMemoryFlagSource();
    source.set('content.readApi.enabled', flagValue);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const { repository } = buildRepository();
    return { repository, flags };
  }

  it('returns 404 when the flag is off, without reading the keyword param', async () => {
    const { repository, flags } = buildDeps(false);
    const { logger } = recordingLogger();
    const handler = createContentReadHandler({ repository, flags, clock: fixedClock, logger });

    const result = await handler(
      fakeEvent({ keyword: 'nutrition' }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
  });

  it('returns 400 when the flag is on but no keyword is given', async () => {
    const { repository, flags } = buildDeps(true);
    const handler = createContentReadHandler({ repository, flags, clock: fixedClock });

    const result = await handler(fakeEvent(), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('returns only published content matching the keyword when the flag is on', async () => {
    const { repository, flags } = buildDeps(true);
    await repository.create(
      'editor-1',
      buildInput({ id: 'published-1', status: 'published', keywords: ['nutrition'] }),
    );
    await repository.create(
      'editor-1',
      buildInput({ id: 'draft-1', status: 'draft', keywords: ['nutrition'] }),
    );
    const handler = createContentReadHandler({ repository, flags, clock: fixedClock });

    const result = await handler(
      fakeEvent({ keyword: 'nutrition' }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 200 });
    const body = JSON.parse((result as { body: string }).body) as { items: ContentItem[] };
    expect(body.items.map((item) => item.id)).toEqual(['published-1']);
  });

  it('logs one line per request', async () => {
    const { repository, flags } = buildDeps(true);
    const { logger, calls } = recordingLogger();
    const handler = createContentReadHandler({ repository, flags, clock: fixedClock, logger });

    await handler(fakeEvent({ keyword: 'nutrition' }), {} as never, undefined as never);
    expect(calls).toEqual([
      { requestId: 'req-1', route: '/content', statusCode: 200, durationMs: 0 },
    ]);
  });
});
