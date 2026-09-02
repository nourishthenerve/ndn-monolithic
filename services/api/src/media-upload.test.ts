import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import {
  CONTENT_MEDIA_PREFIX,
  createMediaUploadHandler,
  MEDIA_UPLOAD_ROUTES,
  PUBLIC_MEDIA_PREFIX,
  WORKSHOP_MEDIA_PREFIX,
} from './media-upload.js';

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

const WORKSHOP_ROUTE = 'POST /workshops/media-upload-url';
const CONTENT_ROUTE = 'POST /content/media-upload-url';

function fakeEvent(overrides: {
  body?: unknown;
  principal?: Record<string, unknown>;
  routeKey?: string;
}): LambdaAuthorizerEvent {
  return {
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      routeKey: overrides.routeKey ?? WORKSHOP_ROUTE,
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : PRINCIPAL_CONTEXT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

function buildDeps(flagValue = true) {
  const source = new InMemoryFlagSource();
  source.set('workshops.enabled', flagValue);
  source.set('content.authoring.enabled', flagValue);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  const createPresignedPutUrl = vi.fn().mockResolvedValue('https://example-bucket.s3.amazonaws.com/signed');
  return {
    flags,
    createPresignedPutUrl,
    clock: fixedClock,
    generateId: () => 'fixed-id',
  };
}

const validBody = { fileName: 'poster.jpg', contentType: 'image/jpeg' };

describe('createMediaUploadHandler — flag gating', () => {
  it('returns 404 when workshops.enabled is off, without checking the principal or S3', async () => {
    const deps = buildDeps(false);
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ principal: undefined, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });
});

describe('createMediaUploadHandler — authentication and authorisation', () => {
  it('rejects a request with no verified principal, 401, and never calls S3', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ principal: undefined, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 401 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });

  it('rejects a patient with 403 and never calls S3', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ principal: PATIENT_CONTEXT, body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 403 });
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
    expect(parsed.key).toBe('media/workshops/fixed-id-poster.jpg');
    expect(parsed.uploadUrl).toBe('https://example-bucket.s3.amazonaws.com/signed');
    expect(deps.createPresignedPutUrl).toHaveBeenCalledWith(
      'media/workshops/fixed-id-poster.jpg',
      'image/jpeg',
    );
  });

  it('issues one for a blog image on its own route, under its own folder', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: CONTENT_ROUTE, body: { fileName: 'hero.png', contentType: 'image/png' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 201 });
    const parsed = JSON.parse((result as { body: string }).body) as { key: string };
    expect(parsed.key).toBe('media/content/fixed-id-hero.png');
    expect(parsed.key.startsWith(CONTENT_MEDIA_PREFIX)).toBe(true);
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
    // Every '/' in the caller-supplied file name is stripped, so the only
    // '/' characters in the key are the fixed prefix's own — never a
    // caller-controlled path segment. Counted against the prefix rather
    // than a literal, so this keeps meaning the same thing if the prefix
    // gains or loses a folder.
    expect(parsed.key.startsWith(WORKSHOP_MEDIA_PREFIX)).toBe(true);
    expect(parsed.key.slice(WORKSHOP_MEDIA_PREFIX.length)).not.toContain('/');
  });

  // The point of the `media/` prefix, asserted rather than described: it is
  // the exact set of objects `/media/*` serves to the public, so a surface
  // that escaped it would be publishing to a URL nothing serves — or, if
  // the edge ever rewrote the path instead, publishing private keys.
  it.each(MEDIA_UPLOAD_ROUTES)('keeps %s inside the public media prefix', async (routeKey) => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey, body: validBody }),
      {} as never,
      undefined as never,
    );
    const parsed = JSON.parse((result as { body: string }).body) as { key: string };
    expect(parsed.key.startsWith(PUBLIC_MEDIA_PREFIX)).toBe(true);
  });

  it('answers 404 on a route it does not serve, rather than presigning against a default', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    const result = await handler(
      fakeEvent({ routeKey: 'POST /assessments/media-upload-url', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
  });

  it('does not treat an inherited property name as a route', async () => {
    const deps = buildDeps();
    const handler = createMediaUploadHandler(deps);

    // `SURFACES['constructor']` resolves to a function on a bare lookup.
    // `Object.hasOwn` is what stops a request-controlled string reaching it.
    const result = await handler(
      fakeEvent({ routeKey: 'constructor', body: validBody }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 404 });
    expect(deps.createPresignedPutUrl).not.toHaveBeenCalled();
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
