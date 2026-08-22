// TASK 1.4.2 step 4: the moderation queue, plus the public read boundary —
// both live on `GET /testimonials` because HttpApi can only route one path
// to one Lambda integration, and the plan's own shape for this task
// overloads that single path for two audiences: an unauthenticated visitor
// (no `status` query param, or `status=published`) gets only published
// testimonials; an admin passing `?status=pending_review` with a valid
// bearer token gets the moderation queue. `POST /testimonials/{id}/publish`
// and `.../reject` are always admin-token-gated. Same admin-token bridge
// content-authoring.ts introduced (TASK 1.3.2) — reused as-is, not
// reimplemented.
import type { Testimonial } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { verifyAdminToken } from './admin-auth.js';
import { actorContext, requestOriginOf } from './audit.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { TestimonialRepository } from './testimonial-repository.js';

const TESTIMONIAL_MODERATION_LOG_SAMPLE_RATE = 1;

export interface TestimonialModerationDeps {
  readonly repository: TestimonialRepository;
  readonly flags: FlagReader;
  /** Resolves the current `ADMIN_API_TOKEN` (SSM SecureString, D-14) — same shared secret content-authoring-handler.ts resolves. */
  readonly getAdminToken: () => Promise<string>;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

function requireAdmin(event: Parameters<APIGatewayProxyHandlerV2>[0], adminToken: string): boolean {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  return verifyAdminToken(authHeader, adminToken);
}

export function createTestimonialModerationHandler(
  deps: TestimonialModerationDeps,
): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ??
    createSampledLogger({ clock, sampleRate: TESTIMONIAL_MODERATION_LOG_SAMPLE_RATE });

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

    switch (routeKey) {
      case 'GET /testimonials': {
        if (event.queryStringParameters?.status !== 'pending_review') {
          // The public boundary: no flag gate (unlike content.readApi.enabled)
          // — nothing is ever published without an admin's explicit action
          // behind testimonials.moderationQueue.enabled below, so this can't
          // leak anything early.
          const items: Testimonial[] = await deps.repository.findPublished();
          return respond(200, { items });
        }

        // The moderation queue.
        if (!(await deps.flags.isEnabled('testimonials.moderationQueue.enabled'))) {
          return respond(404, { error: 'NOT_FOUND' });
        }
        const adminToken = await deps.getAdminToken();
        if (!requireAdmin(event, adminToken)) {
          return respond(401, { error: 'UNAUTHORIZED' });
        }
        const items: Testimonial[] = await deps.repository.findPendingReview();
        return respond(200, { items });
      }

      case 'POST /testimonials/{id}/publish':
      case 'POST /testimonials/{id}/reject': {
        if (!(await deps.flags.isEnabled('testimonials.moderationQueue.enabled'))) {
          return respond(404, { error: 'NOT_FOUND' });
        }
        // Checked before any repository call — a rejected token must
        // mutate nothing, not even a read.
        const adminToken = await deps.getAdminToken();
        if (!requireAdmin(event, adminToken)) {
          return respond(401, { error: 'UNAUTHORIZED' });
        }
        const id = event.pathParameters?.id;
        if (!id) {
          return respond(400, { error: 'ID_REQUIRED' });
        }
        try {
          // TASK 1.3.2's admin-token bridge proves "an authorised
          // moderator," not *which* one — same one shared actor until
          // Phase 2's Cognito RBAC, audited regardless (audit.ts), with
          // the role and request origin TASK 2.1.3 added.
          const actor = actorContext(
            { subjectId: 'admin-token', role: 'admin-token' },
            requestOriginOf(event),
          );
          const item = routeKey.endsWith('/publish')
            ? await deps.repository.publish(actor, id)
            : await deps.repository.reject(actor, id);
          return respond(200, { item });
        } catch (error) {
          if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
            return respond(404, { error: error.code });
          }
          throw error;
        }
      }

      default:
        return respond(404, { error: 'NOT_FOUND' });
    }
  };
}
