// TASK 1.5.1 step 3: "an admin-token-gated endpoint issuing a presigned S3
// PutObject URL scoped to workshops/ — the runtime role gets PutObject
// only, never DeleteObject." Kept SDK-free (no `@aws-sdk/client-s3` import
// here) so it's unit-testable without AWS — `createPresignedPutUrl` is
// injected; media-upload-handler.ts is the only place that calls the real
// S3 presigner. Same flag/admin-token-gate ordering as
// content-authoring.ts/workshop-authoring.ts: flag first, then the token
// (checked before any S3 call — a rejected token must produce no
// presigned URL, not even for a bucket key nobody will ever write to).
import { randomUUID } from 'node:crypto';

import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { z } from 'zod';

import { verifyAdminToken } from './admin-auth.js';
import { systemClock, type Clock } from './clock.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';

/** infra/src/data-stack.ts's MediaUploadFunctionRole is granted `s3:PutObject` on exactly this prefix — every key this file generates must stay inside it. */
export const WORKSHOP_MEDIA_PREFIX = 'workshops/';

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

/** Strips anything but ASCII letters/digits/dot/dash/underscore — an admin-supplied file name is never used as-is in a key or a bucket path. */
function sanitizeFileName(fileName: string): string {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '-');
}

const MEDIA_UPLOAD_LOG_SAMPLE_RATE = 1;
const MEDIA_UPLOAD_ROUTE = 'POST /workshops/media-upload-url';

export interface MediaUploadDeps {
  readonly flags: FlagReader;
  /** Resolves the current `ADMIN_API_TOKEN` (SSM SecureString, D-14) — same shared secret every other admin-gated handler in this repo resolves. */
  readonly getAdminToken: () => Promise<string>;
  /** Presigned `PutObject` URL for `key`/`contentType`, scoped to the media bucket's `workshops/` prefix — the one S3 call this handler ever needs, injected so no test calls real S3. */
  readonly createPresignedPutUrl: (key: string, contentType: string) => Promise<string>;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** Defaults to node:crypto's randomUUID — injectable so tests can assert on a known key. */
  readonly generateId?: () => string;
}

export function createMediaUploadHandler(deps: MediaUploadDeps): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: MEDIA_UPLOAD_LOG_SAMPLE_RATE });
  const generateId = deps.generateId ?? randomUUID;

  return async (event) => {
    const start = clock.now();

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: MEDIA_UPLOAD_ROUTE,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // Flag: workshops.enabled — same flag the read/authoring endpoints
    // gate on; a presigned upload URL is only ever useful alongside the
    // rest of the feature.
    if (!(await deps.flags.isEnabled('workshops.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
    const adminToken = await deps.getAdminToken();
    if (!verifyAdminToken(authHeader, adminToken)) {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const parsed = uploadBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
    }

    const key = `${WORKSHOP_MEDIA_PREFIX}${generateId()}-${sanitizeFileName(parsed.data.fileName)}`;
    const uploadUrl = await deps.createPresignedPutUrl(key, parsed.data.contentType);
    return respond(201, { uploadUrl, key });
  };
}
