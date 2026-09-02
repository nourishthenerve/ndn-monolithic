// TASK 1.5.1 step 3: "a clinician-gated endpoint issuing a presigned S3
// PutObject URL scoped to workshops/ — the runtime role gets PutObject
// only, never DeleteObject." Kept SDK-free (no `@aws-sdk/client-s3` import
// here) so it's unit-testable without AWS — `createPresignedPutUrl` is
// injected; media-upload-handler.ts is the only place that calls the real
// S3 presigner.
//
// TASK 2.5.4: the admin-token bridge this file stood behind since 1.5.1 is
// retired — `requirePrincipal`/`can()` against `authz-matrix.ts`'s
// 'Workshop' row now gate this route (a presigned poster upload has no
// independent existence from the workshop it is for, so it reuses that row
// rather than getting its own — see docs/plan/04-data-model-rbac.md's own
// note). Same flag-then-authorisation ordering the old token check had: a
// rejected/absent principal must produce no presigned URL, not even for a
// bucket key nobody will ever write to.
import { randomUUID } from 'node:crypto';

import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { requirePrincipal } from './request-principal.js';

/**
 * **The public-media boundary, and the whole reason these keys are shaped
 * this way.**
 *
 * `web-stack.ts`'s `/media/*` behaviour hands the media bucket to anyone
 * on the internet, and it does no path rewriting: a request for
 * `/media/x/y.jpg` asks S3 for the key `media/x/y.jpg`, verbatim. So the
 * `media/` key prefix *is* the set of publicly readable objects — exactly,
 * and by construction rather than by care.
 *
 * That is what keeps assessment attachments out of it. They are in the
 * same bucket under `assessments/`, which is not under `media/`, so no URL
 * that behaviour can serve reaches one. The alternative — rewriting
 * `/media/…` to strip the prefix at the edge — would have made
 * `/media/assessments/<key>` serve a clinical recording to the public.
 * `assessment-upload-handler.ts` already names that as the catastrophic
 * case; this is the arrangement that makes it unreachable rather than
 * merely unrouted.
 *
 * `infra/src/web-stack.ts` grants `MediaUploadFunctionRole` `s3:PutObject`
 * on `media/*` and nothing wider, so a key this file generated outside the
 * prefix would fail to sign rather than quietly land somewhere private.
 */
export const PUBLIC_MEDIA_PREFIX = 'media/';

/**
 * @deprecated 2026-09-02 — kept only so the name still resolves. The
 * poster prefix is now `media/workshops/`; see `PUBLIC_MEDIA_PREFIX`.
 */
export const WORKSHOP_MEDIA_PREFIX = `${PUBLIC_MEDIA_PREFIX}workshops/`;

/** Blog post images. Same bucket, same public prefix, its own folder so the two surfaces stay separable. */
export const CONTENT_MEDIA_PREFIX = `${PUBLIC_MEDIA_PREFIX}content/`;

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

const uploadBodySchema = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.enum(ALLOWED_CONTENT_TYPES),
});

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Strips anything but ASCII letters/digits/dot/dash/underscore — a caller-supplied file name is never used as-is in a key or a bucket path. */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
}

const MEDIA_UPLOAD_LOG_SAMPLE_RATE = 1;

/**
 * The two surfaces that can carry an image, each with the row that governs
 * it, the flag that turns it on, and the folder its keys land in.
 *
 * 2026-09-02, the owner: *"principal clinician should be able to upload
 * media files while creating blog posts and workshops."* Workshops had the
 * endpoint (TASK 1.5.1) and no caller; blog posts had neither.
 *
 * Deliberately one handler over two routes rather than two handlers. The
 * interesting part of a presign is which row authorises it and which
 * prefix it may write to, and a table makes both readable side by side —
 * where a copied file would let them drift, and it is a copied file that
 * eventually presigns a blog image against the workshop row.
 */
const SURFACES = {
  'POST /workshops/media-upload-url': {
    // TASK 2.5.4: reused rather than given a dedicated row — a presigned
    // poster upload has no independent existence from the workshop it is
    // for. The same reasoning holds for a blog image and its post.
    resource: { entityType: 'workshop' },
    flag: 'workshops.enabled',
    prefix: WORKSHOP_MEDIA_PREFIX,
  },
  'POST /content/media-upload-url': {
    resource: { entityType: 'content-item' },
    flag: 'content.authoring.enabled',
    prefix: CONTENT_MEDIA_PREFIX,
  },
} as const satisfies Record<
  string,
  {
    readonly resource: { readonly entityType: string };
    readonly flag: string;
    readonly prefix: string;
  }
>;

type MediaUploadRoute = keyof typeof SURFACES;

export const MEDIA_UPLOAD_ROUTES = Object.keys(SURFACES) as readonly MediaUploadRoute[];

export interface MediaUploadDeps {
  readonly flags: FlagReader;
  /** Presigned `PutObject` URL for `key`/`contentType`, scoped to the media bucket's `workshops/` prefix — the one S3 call this handler ever needs, injected so no test calls real S3. */
  readonly createPresignedPutUrl: (key: string, contentType: string) => Promise<string>;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** Defaults to node:crypto's randomUUID — injectable so tests can assert on a known key. */
  readonly generateId?: () => string;
}

export function createMediaUploadHandler(
  deps: MediaUploadDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: MEDIA_UPLOAD_LOG_SAMPLE_RATE });
  const generateId = deps.generateId ?? randomUUID;

  return async (event) => {
    const start = clock.now();
    const routeKey = event.requestContext.routeKey;

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // `Object.hasOwn`, not a bare lookup: `routeKey` is request-controlled,
    // and an inherited property (`'constructor'`, `'toString'`) would
    // otherwise resolve to a function and be treated as a surface.
    if (!Object.hasOwn(SURFACES, routeKey)) {
      return respond(404, { error: 'NOT_FOUND' });
    }
    const surface = SURFACES[routeKey as MediaUploadRoute];

    // Flag first, exactly as before: the feature's own flag, because a
    // presigned upload URL is only ever useful alongside the rest of it.
    // A rejected or absent principal must produce no presigned URL either,
    // not even for a key nobody will ever write to — hence this ordering.
    if (!(await deps.flags.isEnabled(surface.flag))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }
    if (!can(principal, 'create', surface.resource).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }

    const parsed = uploadBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
    }

    const key = `${surface.prefix}${generateId()}-${sanitizeFileName(parsed.data.fileName)}`;
    const uploadUrl = await deps.createPresignedPutUrl(key, parsed.data.contentType);
    return respond(201, { uploadUrl, key });
  };
}
