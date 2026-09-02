// 2026-09-02: a patient writing about their own care.
//
// The owner: *"for patients, when logged in, should have option to upload
// maximum one testimonial with option to update it. otherwise, submit a
// testimonial shouldn't be available for public and all kinds of
// clinicians. Also, there is no concept of review a testimonial — it
// should go live as soon as patient submits it from his account."*
//
// ## What this replaces, and what stopped being necessary
//
// `testimonial-submission.ts` was an anonymous public form: Turnstile,
// then a rate limiter, then a `pending_review` row for somebody to
// approve. All three existed for one reason — the author was a stranger.
// Behind a signed-in patient account none of them has anything to do. The
// authorizer has already established who is asking; there is exactly one
// record per patient, so flooding is not a shape the data can take; and
// "review" was the practice deciding whether to believe an unattributed
// quote from the internet, which is not the question when the patient is
// in the caseload.
//
// So this file is smaller than the thing it replaces, and that is the
// point rather than a saving.
//
// ## Three routes, one record
//
// `PUT` rather than `POST`, on a singleton path (`/testimonials/mine`)
// rather than a collection. That is the whole cardinality rule expressed
// in the URL: there is no id to choose, no second one to create, and
// submitting twice is idempotent by construction. The handler never
// checks "do they already have one?", because the question cannot come up.
//
// `DELETE` is a withdrawal, not a deletion — the row transitions to
// `withdrawn` and keeps its text (00-conventions.md's no-delete rule, and
// so the patient can put it back). It is here because publication rests on
// the author's consent, and consent that cannot be withdrawn is not
// consent.
import type { Locale } from '@ndn/i18n';
import type { Principal, Testimonial } from '@ndn/shared-types';
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
import type { TestimonialRepository } from './testimonial-repository.js';

const TESTIMONIAL_AUTHORING_LOG_SAMPLE_RATE = 1;

/**
 * The matrix row every route here is governed by — `authz-matrix.ts`'s
 * `'Testimonial (own)'`, whose only non-empty column is `Patient (own)`.
 *
 * `ownerPatientId` is the caller's own id, so `resolveColumn` lands a
 * patient in `Patient (own)` and everyone else outside it. A clinician
 * carries no `patientId` at all, so theirs is `undefined`, which can never
 * equal a non-empty id — the same "no special-cased rejection needed"
 * shape `GET /caseload/mine` and `/patients/me/notifications` rely on.
 * There is no branch here that denies clinicians; the matrix does it.
 */
const TESTIMONIAL_ENTITY = 'testimonial';

/**
 * The consent wording in force. Stored on the record so a row always says
 * which text its author actually agreed to, rather than whichever text the
 * site happens to show today.
 */
export const TESTIMONIAL_CONSENT_TEXT_VERSION = '2026-09-02';

export const LIST_ROUTE = 'GET /testimonials/mine';
export const UPSERT_ROUTE = 'PUT /testimonials/mine';
export const WITHDRAW_ROUTE = 'DELETE /testimonials/mine';

const attributionSchema = z
  .object({
    display: z.enum(['full', 'firstNameOnly', 'anonymous']),
    name: z.string().min(1).max(200).optional(),
  })
  .refine((attribution) => attribution.display === 'anonymous' || Boolean(attribution.name), {
    message: 'name is required unless the attribution is anonymous',
  });

const upsertBodySchema = z.object({
  quote: z.string().min(1).max(2000),
  attribution: attributionSchema,
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

export interface TestimonialAuthoringDeps {
  readonly repository: TestimonialRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** The locale a quote is stored under. One locale today (`@ndn/i18n`'s `supportedLocales` is `['en']`); named rather than inlined so the day there are two is a change here and not a hunt. */
  readonly defaultLocale?: Locale;
}

export function createTestimonialAuthoringHandler(
  deps: TestimonialAuthoringDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: TESTIMONIAL_AUTHORING_LOG_SAMPLE_RATE });
  const locale: Locale = deps.defaultLocale ?? 'en';

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

    // Same flag as the public read's own feature. A testimonial nobody can
    // see is not worth writing, and one nobody can write is not worth a
    // separate switch.
    if (!(await deps.flags.isEnabled('testimonials.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const resource = { entityType: TESTIMONIAL_ENTITY, ownerPatientId: principal.patientId } as const;
    const patientId = principal.patientId;

    if (routeKey === LIST_ROUTE) {
      if (!can(principal, 'read', resource).allowed || !patientId) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      const item = await deps.repository.findForPatient(patientId);
      // 200 with `item: null` rather than 404. "You have not written one"
      // is the ordinary state of this resource, not an error, and the
      // account page renders an empty form for it either way.
      return respond(200, { item: item ?? null });
    }

    if (routeKey === UPSERT_ROUTE) {
      // `create` and `update` are the same cell here and the same request:
      // the caller cannot know, and need not, whether this is their first.
      // Asking for both is what makes that honest.
      if (
        !can(principal, 'create', resource).allowed ||
        !can(principal, 'update', resource).allowed ||
        !patientId
      ) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      const parsed = upsertBodySchema.safeParse(parseJsonBody(event));
      if (!parsed.success) {
        return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const item: Testimonial = await deps.repository.upsertForPatient(
        actorFromPrincipal(principal, requestOriginOf(event)),
        {
          authorPatientId: patientId,
          quote: { [locale]: parsed.data.quote },
          attribution: parsed.data.attribution,
          consentTextVersion: TESTIMONIAL_CONSENT_TEXT_VERSION,
        },
      );
      return respond(200, { item });
    }

    if (routeKey === WITHDRAW_ROUTE) {
      if (!can(principal, 'withdraw', resource).allowed || !patientId) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      try {
        const item = await deps.repository.withdrawForPatient(
          actorFromPrincipal(principal, requestOriginOf(event)),
          patientId,
        );
        return respond(200, { item });
      } catch (error) {
        if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
          return respond(404, { error: error.code });
        }
        throw error;
      }
    }

    return respond(404, { error: 'NOT_FOUND' });
  };
}
