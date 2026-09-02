// TASK 1.5.1: the write side of workshop-repository.ts, same split
// content-authoring.ts established for content — this file stays SDK-free
// and unit-testable; workshop-authoring-handler.ts wires the real
// DynamoDB-backed store together. Every mutation goes through
// WorkshopRepository.create/update/publish/cancel — no endpoint here calls
// anything delete-shaped, and `cancel` only ever transitions `status` (see
// WorkshopRepository.cancel's own comment).
//
// TASK 2.5.4: the admin-token bridge this file stood behind since 1.5.1 is
// retired — `requirePrincipal`/`can()` against `authz-matrix.ts`'s
// 'Workshop' row now gate every route, and the audit trail names *which*
// clinician acted instead of one shared `admin-token` actor.
import { supportedLocales } from '@ndn/i18n';
import type { Principal, Workshop } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { requirePrincipal } from './request-principal.js';
import type {
  CreateWorkshopInput,
  UpdateWorkshopInput,
  WorkshopRepository,
} from './workshop-repository.js';

const SUPPORTED_LOCALES = new Set<string>(supportedLocales);

const detailSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
});

// Same shape as content-authoring.ts's translationsSchema — keyed by plain
// `string` (not the narrower `Locale` union) and validated against
// `supportedLocales` in the `.refine` below, so an unrecognised locale is a
// 400, not a silently-accepted dead entry.
const detailsSchema = z
  .record(z.string(), detailSchema)
  .refine((details) => Object.keys(details).length > 0, {
    message: 'details must include at least one locale',
  })
  .refine((details) => Object.keys(details).every((locale) => SUPPORTED_LOCALES.has(locale)), {
    message: 'details keys must be a supported locale',
  });

// dateTimeUtc is validated as "parses to a real instant", not with a strict
// ISO-8601 format validator — the store always writes/reads
// `Date#toISOString()` output, but this is the one boundary that accepts a
// clinician-authored string, so it's kept permissive about format while
// still rejecting nonsense.
const dateTimeUtcSchema = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'dateTimeUtc must be a valid date-time string',
});

const createWorkshopBodySchema = z.object({
  id: z.string().min(1),
  status: z.enum(['draft', 'published', 'cancelled']),
  dateTimeUtc: dateTimeUtcSchema,
  // D-31: optional, not required — workshops are announcement-only, no
  // registration or payment exists on the public site to enforce a
  // capacity or charge a price against. Still validated when given,
  // since TASK 1.5.2's own dead Stripe Checkout code (never wired, never
  // to be turned on) would misbehave against a negative/fractional value
  // if it were ever reached.
  capacity: z.number().int().positive().optional(),
  priceMinorUnits: z.number().int().nonnegative().optional(),
  posterKey: z.string().min(1).optional(),
  details: detailsSchema,
});

const updateWorkshopBodySchema = z
  .object({
    dateTimeUtc: dateTimeUtcSchema.optional(),
    capacity: z.number().int().positive().optional(),
    priceMinorUnits: z.number().int().nonnegative().optional(),
    posterKey: z.string().min(1).optional(),
    details: detailsSchema.optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'at least one field must be given',
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

const WORKSHOP_AUTHORING_LOG_SAMPLE_RATE = 1;

/** TASK 2.5.4: the matrix row this file's every mutation is governed by — `authz-matrix.ts`'s 'Workshop'. */
const WORKSHOP_RESOURCE = { entityType: 'workshop' } as const;

export interface WorkshopAuthoringDeps {
  readonly repository: WorkshopRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createWorkshopAuthoringHandler(
  deps: WorkshopAuthoringDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: WORKSHOP_AUTHORING_LOG_SAMPLE_RATE });

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

    // Flag: workshops.enabled — default off, same "invisible until ready"
    // convention as content.authoring.enabled.
    if (!(await deps.flags.isEnabled('workshops.enabled'))) {
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
    // replacing TASK 1.5.1's one shared `admin-token` actor.
    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    try {
      switch (routeKey) {
        // 2026-09-02: the authoring side's own list, unpublished and past
        // workshops included — see content-authoring.ts's own note on why
        // this is gated on `update` rather than `read`.
        case 'GET /workshops/authored': {
          if (!can(principal, 'update', WORKSHOP_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const items = await deps.repository.findAll();
          return respond(200, { items });
        }
        case 'POST /workshops': {
          if (!can(principal, 'create', WORKSHOP_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const parsed = createWorkshopBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          const item = await deps.repository.create(
            actor,
            parsed.data as unknown as CreateWorkshopInput,
          );
          return respond(201, { item });
        }
        case 'PATCH /workshops/{id}': {
          if (!can(principal, 'update', WORKSHOP_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const parsed = updateWorkshopBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          const item = await deps.repository.update(
            actor,
            id,
            parsed.data as unknown as UpdateWorkshopInput,
          );
          return respond(200, { item });
        }
        case 'POST /workshops/{id}/publish': {
          if (!can(principal, 'update', WORKSHOP_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const item: Workshop = await deps.repository.publish(actor, id);
          return respond(200, { item });
        }
        case 'POST /workshops/{id}/cancel': {
          if (!can(principal, 'update', WORKSHOP_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const item: Workshop = await deps.repository.cancel(actor, id);
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
