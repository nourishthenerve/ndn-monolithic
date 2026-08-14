import { describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import { createMediaUploadHandler, WORKSHOP_MEDIA_PREFIX } from './media-upload.js';

const fixedClock: Clock = { now: () => new Date('2026-06-01T00:00:00.000Z') };
const ADMIN_TOKEN = 'test-admin-token';

function fakeEvent(overrides: { headers?: Record<string, string>; body?: unknown }) {
  return {
    headers: overrides.headers ?? { authorization: `Bearer ${ADMIN_TOKEN}` },
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: { requestId: 'req-1' },
  } as never;
}

function buildDeps(flagValue = true) {
  const source = new InMemoryFlagSource();
  source.set('workshops.enabled', flagValue);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  const createPresignedPutUrl = vi.fn().mockResolvedValue('https://example-bucket.s3.amazonaws.com/signed');
  return {
    flags,
    getAdminToken: async () => ADMIN_TOKEN,
    createPresignedPutUrl,
    clock: fixedClock,
    generateId: () => 'fixed-id',
  };
}

const validBody = { fileName: 'poster.jpg', contentType: 'image/jpeg' };

describe('createMediaUploadHandler — flag gating', () => {
  it('returns 404 when workshops.enabled is off, without checking the token or S3', async () => {
    const deps = buildDeps(false);
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ headers: {}, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });
});

describe('createMediaUploadHandler — admin token gate', () => {
  it('rejects a missing Authorization header with 401 and never calls S3', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ headers: {}, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });

  it('rejects a wrong token with 401', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ headers: { authorization: 'Bearer wrong-token' }, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });
});

describe('createMediaUploadHandler — POST /workshops/media-upload-url', () => {
  it('issues a presigned URL for a key scoped to the workshops/ prefix', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 201 });
    const parsed = JSON.parse((result as { body: string }).body) as {
      uploadUrl: string;
      key: string;
    };
    expect(parsed.key.startsWith(WORKSHOP_MEDIA_PREFIX)).toBe(true);
    expect(parsed.key).toBe('workshops/fixed-id-poster.jpg');
    expect(parsed.uploadUrl).toBe('https://example-bucket.s3.amazonaws.com/signed');
    expect(deps.createPresignedPutUrl).toHaveBeenCalledWith(
      'workshops/fixed-id-poster.jpg',
      'image/jpeg',
    );
  });

  it('sanitises a file name containing path separators so the key never gains extra segments', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ body: { fileName: '../../etc/passwd.jpg', contentType: 'image/jpeg' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 201 });
    const parsed = JSON.parse((result as { body: string }).body) as { key: string };
    // Every '/' in the admin-supplied file name is stripped — the key can
    // only ever have the one '/' between the fixed prefix and the
    // generated file name, never an admin-controlled path segment.
    expect(parsed.key.split('/')).toHaveLength(2);
    expect(parsed.key.startsWith(WORKSHOP_MEDIA_PREFIX)).toBe(true);
  });

  it('rejects a missing fileName with 400', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ body: { contentType: 'image/jpeg' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });

  it('rejects an unsupported contentType with 400', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ body: { fileName: 'poster.svg', contentType: 'image/svg+xml' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });
});
