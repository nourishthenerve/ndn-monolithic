// TASK 1.3.2: the write side of content-repository.ts's read/write split
// (content-read-handler.ts stays public and read-only; this file is the
// clinician-gated counterpart). Every mutation goes through
// ContentRepository.create/update/publish/unpublish — no endpoint here
// calls anything delete-shaped, and `unpublish` only ever transitions
// `status` (see ContentRepository.unpublish's own comment).
//
// TASK 2.5.4: the admin-token bridge this file stood behind since 1.3.2 is
// retired — `requirePrincipal`/`can()` against `authz-matrix.ts`'s
// 'Content item' row now gate every route, and the audit trail names
// *which* clinician acted instead of one shared `admin-token` actor.
//
// Zod-validated request bodies (00-conventions.md: "Zod for runtime
// validation at every boundary") — the first services/api handler that
// parses an untrusted HTTP body; content-read-handler.ts only ever reads a
// query-string keyword.
import { supportedLocales } from '@ndn/i18n';
import type { ContentItem, Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type {
  ContentRepository,
  CreateContentInput,
  UpdateContentInput,
} from './content-repository.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { requirePrincipal } from './request-principal.js';

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

/** TASK 2.5.4: the matrix row this file's every mutation is governed by — `authz-matrix.ts`'s 'Content item'. */
const CONTENT_RESOURCE = { entityType: 'content-item' } as const;

export interface ContentAuthoringDeps {
  readonly repository: ContentRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createContentAuthoringHandler(
  deps: ContentAuthoringDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
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

    // TASK 2.5.4: the real Lambda authorizer (2.2.2) replaces the admin
    // bearer token — a rejected/absent principal must mutate nothing, not
    // even a read, same ordering the token check had.
    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    // The audit trail (audit.ts) now records *which* clinician acted,
    // replacing TASK 1.3.2's one shared `admin-token` actor.
    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    try {
      switch (routeKey) {
        case 'POST /content': {
          if (!can(principal, 'create', CONTENT_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
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
          if (!can(principal, 'update', CONTENT_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
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
          if (!can(principal, 'update', CONTENT_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const item: ContentItem = await deps.repository.publish(actor, id);
          return respond(200, { item });
        }
        case 'POST /content/{id}/unpublish': {
          if (!can(principal, 'update', CONTENT_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
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
