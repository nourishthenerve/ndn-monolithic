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
import type { Testimonial, TestimonialAttribution, TestimonialCuration } from '@ndn/shared-types';
import { MAX_FEATURED_TESTIMONIALS } from '@ndn/shared-types';
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
  /**
   * Present only on the ones the principal put on the landing page, and
   * equal to their position in that strip — `0` is the first quote a
   * visitor sees.
   *
   * A rank rather than a `featured: true` flag because the owner asked to
   * cherry-pick *"top rated"* testimonials, and "top" is an ordering. It
   * is the only ordering information in this payload: the list itself is
   * chronological, newest first, which is what the testimonials page
   * renders.
   *
   * Publishing a position is not publishing anything private — it is a
   * fact about the site's own layout, and a reader can see it by looking
   * at the page.
   */
  readonly featuredRank?: number;
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

/**
 * How many testimonials the landing page shows when the principal has
 * never curated. Three, because that is what the homepage showed before
 * curation existed — the strip is unchanged until somebody changes it on
 * purpose.
 */
export const DEFAULT_FEATURED_COUNT = 3;

/**
 * The public list, curated — the whole of what `GET /testimonials` returns
 * and the one place the owner's two surfaces are decided:
 *
 *   * the **testimonials page** renders every item, in the order they come
 *     out of here (newest first, `findPublished`'s own sort);
 *   * the **landing page** renders the ones carrying a `featuredRank`, in
 *     rank order.
 *
 * One list rather than two, because the two pages fetch the same URL and
 * `LiveTestimonialList` reconciles both from it — two payloads would be
 * two chances for the homepage and the archive to disagree about what a
 * testimonial says.
 *
 * ## Three rules, in order
 *
 * 1. **Published is still the boundary.** `published` is what
 *    `findPublished` returned, so a withdrawn testimonial cannot be shown
 *    by a stale pick, and a pick naming a testimonial that no longer
 *    exists is simply dropped. The principal never has to tidy up after a
 *    patient who withdrew.
 * 2. **No curation record means no curation.** Not "nothing is picked" —
 *    see `readCuration`. The site behaves as it did before this feature:
 *    everything published, newest first, the newest three on the homepage.
 * 3. **A saved selection governs completely.** A published testimonial in
 *    neither list appears nowhere public, including an empty selection
 *    that hides all of them. That is the owner's instruction taken at its
 *    word, and it is the one behaviour here a patient cannot see coming
 *    from their own account page — `accountTestimonial.consentNotice` says
 *    so in as many words.
 */
export function curatedTestimonials(
  published: readonly Testimonial[],
  curation: TestimonialCuration | undefined,
): PublicTestimonial[] {
  if (!curation) {
    return published.map((testimonial, index) =>
      index < DEFAULT_FEATURED_COUNT
        ? { ...toPublicTestimonial(testimonial), featuredRank: index }
        : toPublicTestimonial(testimonial),
    );
  }

  const byId = new Map(published.map((testimonial) => [testimonial.id, testimonial]));

  // Deduped and capped here as well as at the write boundary. The record
  // is data, and data written by an older version of the writer — or by
  // hand during an incident — must not be able to put twelve quotes on the
  // homepage or the same one twice.
  const featured: string[] = [];
  for (const id of curation.featured) {
    if (byId.has(id) && !featured.includes(id) && featured.length < MAX_FEATURED_TESTIMONIALS) {
      featured.push(id);
    }
  }
  const rankOf = new Map(featured.map((id, rank) => [id, rank]));
  const shown = new Set([...featured, ...curation.listed.filter((id) => byId.has(id))]);

  // Iterating `published` rather than the picks is what makes the page
  // chronological: the picks carry the landing page's order, never the
  // archive's.
  return published
    .filter((testimonial) => shown.has(testimonial.id))
    .map((testimonial) => {
      const rank = rankOf.get(testimonial.id);
      return rank === undefined
        ? toPublicTestimonial(testimonial)
        : { ...toPublicTestimonial(testimonial), featuredRank: rank };
    });
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
    //
    // Two reads, not one, and they are independent: the picks cannot
    // resurrect an unpublished testimonial, and a missing curation record
    // cannot hide a published one.
    const [published, curation] = await Promise.all([
      deps.repository.findPublished(),
      deps.repository.readCuration(),
    ]);
    return respond(200, { items: curatedTestimonials(published, curation) });
  };
}
