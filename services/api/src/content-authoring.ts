// TASK 1.3.2: the write side of content-repository.ts's read/write split
// (content-read-handler.ts stays public and read-only; this file is the
// admin-token-gated counterpart). Every mutation goes through
// ContentRepository.create/update/publish/unpublish — no endpoint here
// calls anything delete-shaped, and `unpublish` only ever transitions
// `status` (see ContentRepository.unpublish's own comment).
//
// Zod-validated request bodies (00-conventions.md: "Zod for runtime
// validation at every boundary") — the first services/api handler that
// parses an untrusted HTTP body; content-read-handler.ts only ever reads a
// query-string keyword.
import { supportedLocales } from '@ndn/i18n';
import type { ContentItem } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2, APIGatewayProxyHandlerV2 } from 'aws-lambda';
import { z } from 'zod';

import { verifyAdminToken } from './admin-auth.js';
import { actorContext, requestOriginOf } from './audit.js';
import { systemClock, type Clock } from './clock.js';
import type {
  ContentRepository,
  CreateContentInput,
  UpdateContentInput,
} from './content-repository.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';

const SUPPORTED_LOCALES = new Set<string>(supportedLocales);

const translationSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  excerpt: z.string().min(1),
});

// z.record's key type can't itself be the narrow `Locale` union (it's a
// plain `string` catalogue key, same as packages/i18n/src/index.ts's own
// `MessageCatalogue`) — validated against `supportedLocales` in the
// `.refine` below instead, so a locale the i18n package doesn't recognise
// is a 400, not a silently-accepted dead entry.
const translationsSchema = z
  .record(z.string(), translationSchema)
  .refine((translations) => Object.keys(translations).length > 0, {
    message: 'translations must include at least one locale',
  })
  .refine(
    (translations) => Object.keys(translations).every((locale) => SUPPORTED_LOCALES.has(locale)),
    { message: 'translations keys must be a supported locale' },
  );

const createContentBodySchema = z.object({
  id: z.string().min(1),
  contentType: z.literal('blog'),
  status: z.enum(['draft', 'published', 'unpublished']),
  keywords: z.array(z.string().min(1)),
  translations: translationsSchema,
});

const updateContentBodySchema = z
  .object({
    keywords: z.array(z.string().min(1)).optional(),
    translations: translationsSchema.optional(),
  })
  .refine((patch) => patch.keywords !== undefined || patch.translations !== undefined, {
    message: 'at least one of keywords or translations must be given',
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

const CONTENT_AUTHORING_LOG_SAMPLE_RATE = 1;

export interface ContentAuthoringDeps {
  readonly repository: ContentRepository;
  readonly flags: FlagReader;
  /**
   * Resolves the current `ADMIN_API_TOKEN` (SSM SecureString, D-14).
   * A function, not a plain string, so content-authoring-handler.ts's SSM
   * fetch-and-cache can stay out of this file entirely — this file never
   * touches AWS. Called once per request; a real resolver caches
   * internally.
   */
  readonly getAdminToken: () => Promise<string>;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createContentAuthoringHandler(
  deps: ContentAuthoringDeps,
): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: CONTENT_AUTHORING_LOG_SAMPLE_RATE });

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

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

    // Flag: content.authoring.enabled — default off, same "invisible until
    // ready" convention as content.readApi.enabled (content-repository.ts).
    if (!(await deps.flags.isEnabled('content.authoring.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    // Checked before any repository call — a rejected token must mutate
    // nothing, not even a read.
    const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
    const adminToken = await deps.getAdminToken();
    if (!verifyAdminToken(authHeader, adminToken)) {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    // TASK 1.3.2: the bearer token proves "an authorised editor", not
    // *which* one — there is no user identity yet (Phase 2's Cognito RBAC
    // is what replaces this; see admin-auth.ts's own comment). The audit
    // trail (audit.ts) still records every mutation, just against this one
    // shared actor until then.
    //
    // TASK 2.1.3: that actor is now an `ActorContext` — the same "which
    // one is unknown" claim, plus the role it acted with and the request
    // it arrived on, because an audit row owes a `where` (audit.ts).
    const actor = actorContext(
      { subjectId: 'admin-token', role: 'admin-token' },
      requestOriginOf(event),
    );

    try {
      switch (routeKey) {
        case 'POST /content': {
          const parsed = createContentBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          const item = await deps.repository.create(
            actor,
            parsed.data as unknown as CreateContentInput,
          );
          return respond(201, { item });
        }
        case 'PATCH /content/{id}': {
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const parsed = updateContentBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          const item = await deps.repository.update(
            actor,
            id,
            parsed.data as unknown as UpdateContentInput,
          );
          return respond(200, { item });
        }
        case 'POST /content/{id}/publish': {
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const item: ContentItem = await deps.repository.publish(actor, id);
          return respond(200, { item });
        }
        case 'POST /content/{id}/unpublish': {
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const item: ContentItem = await deps.repository.unpublish(actor, id);
          return respond(200, { item });
        }
        default:
          return respond(404, { error: 'NOT_FOUND' });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
        return respond(404, { error: error.code });
      }
      if (error instanceof AppError && error.code === 'RECORD_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
