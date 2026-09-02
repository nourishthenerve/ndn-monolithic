// The public testimonials read — `GET /testimonials`, unauthenticated,
// published-only. Same posture `content-read-handler.ts` takes for its own
// public read.
//
// **2026-09-02: this file is what remains of `testimonial-moderation.ts`.**
// The owner: *"there is no concept of review a testimonial — it should go
// live as soon as patient submits it from his account."* So
// `GET /testimonials/pending`, `POST /testimonials/{id}/publish` and
// `POST /testimonials/{id}/reject` are gone, together with the
// `testimonials.moderationQueue.enabled` flag that gated them and the
// anonymous public form they existed to vet. What is left is the one route
// that was always public, doing the one thing it always did.
//
// (TASK 2.5.4's note about why the queue could not share this path — the
// authorizer denies any request with no bearer token, so a route anonymous
// visitors must reach cannot sit behind it — is now moot in the happiest
// way: there is no queue.)
//
// ## The projection is the other half of the change
//
// This endpoint used to return `Testimonial` rows whole. That meant a
// public, unauthenticated URL serving `consent.submitterContactHash`, the
// record's status and timestamps, and its id — and, once testimonials
// became patient-authored, the id is a function of the author's patient
// id. None of it was ever rendered. A page shows a quote and a name, so
// that is now all the API says.
import type { Testimonial, TestimonialAttribution } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';

import { systemClock, type Clock } from './clock.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { TestimonialRepository } from './testimonial-repository.js';

const TESTIMONIAL_READ_LOG_SAMPLE_RATE = 1;

export const PUBLIC_READ_ROUTE = 'GET /testimonials';

/**
 * What a visitor is told about a testimonial: the words, and how the
 * author asked to be named. Nothing else exists on this side of the
 * boundary — not an id, not a status, not a timestamp, and above all not
 * `authorPatientId` or the legacy `consent.submitterContactHash`.
 *
 * Built by naming what goes in rather than by deleting what should not, so
 * a field added to `Testimonial` later is private by default and has to be
 * published on purpose.
 */
export interface PublicTestimonial {
  readonly quote: Record<string, string>;
  readonly attribution: TestimonialAttribution;
}

export function toPublicTestimonial(testimonial: Testimonial): PublicTestimonial {
  return {
    quote: testimonial.quote,
    // Rebuilt field by field for the same reason: `name` is only ever
    // published when the author chose to be named, and an anonymous
    // attribution that still carried a name would publish it.
    attribution:
      testimonial.attribution.display === 'anonymous'
        ? { display: 'anonymous' }
        : { display: testimonial.attribution.display, name: testimonial.attribution.name },
  };
}

export interface TestimonialReadDeps {
  readonly repository: TestimonialRepository;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createTestimonialReadHandler(
  deps: TestimonialReadDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: TESTIMONIAL_READ_LOG_SAMPLE_RATE });

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

    if (routeKey !== PUBLIC_READ_ROUTE) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    // No flag and no principal, exactly as before: `findPublished` is the
    // boundary, and a withdrawn or legacy `pending_review` row is not
    // published, so neither reaches here.
    const items = (await deps.repository.findPublished()).map(toPublicTestimonial);
    return respond(200, { items });
  };
}
