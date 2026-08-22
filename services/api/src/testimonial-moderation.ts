// TASK 1.4.2 step 4: the moderation queue, plus the public read boundary.
// `GET /testimonials` is unauthenticated and published-only — no flag gate
// (nothing is ever published without an admin's explicit action behind
// `testimonials.moderationQueue.enabled` below), same posture
// content-read-handler.ts takes for its own public read.
//
// TASK 2.5.4: the moderation queue no longer overloads that same path.
// The real Lambda authorizer (2.2.2) denies outright any request with no
// bearer token — see authorizer.ts's own "there is no path through this
// function that returns isAuthorized: true without a verified token"
// invariant — so a route an anonymous visitor must reach cannot also sit
// behind that authorizer. The queue moves to its own path,
// `GET /testimonials/pending`, which does sit behind it; `GET /testimonials`
// stays exactly as public as it always was. Recorded here because the
// task's own "Interfaces: unchanged" line assumed the two could stay one
// route — see docs/runbooks/testimonials.md for the fuller account.
import type { Testimonial } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { requirePrincipal } from './request-principal.js';
import type { TestimonialRepository } from './testimonial-repository.js';

const TESTIMONIAL_MODERATION_LOG_SAMPLE_RATE = 1;

/** TASK 2.5.4: the matrix row every moderation action is governed by — `authz-matrix.ts`'s 'Testimonial moderation'. */
const TESTIMONIAL_MODERATION_RESOURCE = { entityType: 'testimonial-moderation' } as const;

export interface TestimonialModerationDeps {
  readonly repository: TestimonialRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createTestimonialModerationHandler(
  deps: TestimonialModerationDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
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
        // The public boundary, unconditionally — no flag, no principal.
        const items: Testimonial[] = await deps.repository.findPublished();
        return respond(200, { items });
      }

      case 'GET /testimonials/pending': {
        if (!(await deps.flags.isEnabled('testimonials.moderationQueue.enabled'))) {
          return respond(404, { error: 'NOT_FOUND' });
        }
        let principal;
        try {
          principal = requirePrincipal(event);
        } catch {
          return respond(401, { error: 'UNAUTHORIZED' });
        }
        if (!can(principal, 'read', TESTIMONIAL_MODERATION_RESOURCE).allowed) {
          return respond(403, { error: 'FORBIDDEN' });
        }
        const items: Testimonial[] = await deps.repository.findPendingReview();
        return respond(200, { items });
      }

      case 'POST /testimonials/{id}/publish':
      case 'POST /testimonials/{id}/reject': {
        if (!(await deps.flags.isEnabled('testimonials.moderationQueue.enabled'))) {
          return respond(404, { error: 'NOT_FOUND' });
        }
        // Checked before any repository call — a rejected/absent
        // principal must mutate nothing, not even a read.
        let principal;
        try {
          principal = requirePrincipal(event);
        } catch {
          return respond(401, { error: 'UNAUTHORIZED' });
        }
        if (!can(principal, 'update', TESTIMONIAL_MODERATION_RESOURCE).allowed) {
          return respond(403, { error: 'FORBIDDEN' });
        }
        const id = event.pathParameters?.id;
        if (!id) {
          return respond(400, { error: 'ID_REQUIRED' });
        }
        try {
          // The audit trail (audit.ts) names *which* clinician moderated,
          // replacing TASK 1.3.2's one shared `admin-token` actor.
          const actor = actorFromPrincipal(principal, requestOriginOf(event));
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
