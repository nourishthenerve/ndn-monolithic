// 2026-09-07: the principal cherry-picking which published testimonials the
// site shows, and where.
//
// The owner: *"on webpage the testimonials are shown in some random manner
// I assume. I want the principal clinician to have option to cherry pick top
// rated testimonials on the landing page. However, when someone clicks Read
// more testimonials, there will be more cherry picked shown in chronological
// order with recent at the top. Principal clinician will have option to
// cherry pick these testimonials that goes on the websites landing page and
// those that go inside read more testimonial page."*
//
// ## Curation is not authorship, and this file is where that is kept true
//
// `authz-matrix.ts`'s `Testimonial (own)` row denies the principal every
// cell — *"a practice that can write, edit or approve those words is not
// collecting testimonials"* — and nothing here changes that. These two
// routes are governed by a different row (`Testimonial placement`) over a
// different record (`TESTIMONIAL_CURATION#site`), and there is no code path
// from either of them to a `Testimonial` write:
// `TestimonialRepository.saveCuration` touches the curation record and
// nothing else, and the read below projects testimonials exactly as the
// public read does plus the one thing this screen is for.
//
// So a principal can decide that a quote is on the homepage. They cannot
// change a word of it, cannot rename its author, cannot publish one the
// patient has not published, and cannot unpublish or withdraw one — a
// hidden testimonial is still published, still the patient's, and still
// theirs to withdraw.
//
// ## Why this read returns ids, when the public one refuses to
//
// A testimonial's id is `sha256(authorPatientId)`, and `testimonial-read.ts`
// projects it away because that read is unauthenticated. This one is
// principal-only, and the practice already knows who wrote each testimonial
// — the record carries `authorPatientId`, and the author is a patient in its
// own caseload. `attribution: 'anonymous'` is anonymity from the public
// reader, never from the clinic. The ids travel in request and response
// bodies, which are not logged (`logger.ts` records route, status and
// duration), so the reason they are hashed at all still holds.
import type { Locale } from '@ndn/i18n';
import type {
  Principal,
  Testimonial,
  TestimonialCuration,
  TestimonialPlacement,
} from '@ndn/shared-types';
import { MAX_FEATURED_TESTIMONIALS } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { requirePrincipal } from './request-principal.js';
import type { TestimonialRepository } from './testimonial-repository.js';

const TESTIMONIAL_CURATION_LOG_SAMPLE_RATE = 1;

/**
 * The matrix row both routes are governed by. The resource names no owner
 * and no assigned clinician, because the site's own marketing has neither
 * — every non-principal column of that row is `DENIED`, so `resolveColumn`
 * landing anyone else anywhere is a refusal without a branch here.
 */
const PLACEMENT_ENTITY = 'testimonial-placement';

export const READ_ROUTE = 'GET /testimonials/curation';
export const SAVE_ROUTE = 'PUT /testimonials/curation';

/**
 * One published testimonial as the curation screen sees it: the words (so
 * the principal can tell which is which), the credit, when it was first
 * published, and where it currently appears.
 *
 * `placement` is derived from the curation record rather than stored on the
 * testimonial — the same three-way choice the screen offers, computed once
 * here so the UI does not re-derive it from two arrays.
 */
export interface CuratableTestimonial {
  readonly id: string;
  readonly quote: Record<string, string>;
  readonly attribution: Testimonial['attribution'];
  readonly publishedAt: string;
  readonly placement: TestimonialPlacement;
  /** Position on the landing page, present only when `placement` is `'landing'`. */
  readonly featuredRank?: number;
}

const picksSchema = z.object({
  featured: z.array(z.string().min(1)).max(MAX_FEATURED_TESTIMONIALS),
  listed: z.array(z.string().min(1)).max(500),
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

function hasDuplicates(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}

export interface TestimonialCurationDeps {
  readonly repository: TestimonialRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  /** Unused by the logic and named for symmetry with the authoring handler — a quote is stored per locale and this screen renders whichever it finds. */
  readonly defaultLocale?: Locale;
}

export function createTestimonialCurationHandler(
  deps: TestimonialCurationDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: TESTIMONIAL_CURATION_LOG_SAMPLE_RATE });

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

    // The same flag the public read's own feature uses. Curating a list
    // nobody can see is not a separate capability.
    if (!(await deps.flags.isEnabled('testimonials.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const resource = { entityType: PLACEMENT_ENTITY } as const;

    /**
     * The screen's whole state, built from the two records it spans.
     *
     * Both are parameters rather than reads, because the save path has
     * already fetched the published list to validate against and reading it
     * a second time would be a second GSI2 query plus a GetItem per
     * testimonial for an answer it is holding.
     */
    const viewOf = (
      published: readonly Testimonial[],
      curation: TestimonialCuration | undefined,
    ) => {
      const rankOf = new Map((curation?.featured ?? []).map((id, rank) => [id, rank]));
      const listed = new Set(curation?.listed ?? []);
      const items: CuratableTestimonial[] = published.map((testimonial) => {
        const rank = rankOf.get(testimonial.id);
        const placement: TestimonialPlacement =
          rank !== undefined ? 'landing' : listed.has(testimonial.id) ? 'page' : 'hidden';
        return {
          id: testimonial.id,
          quote: testimonial.quote,
          attribution: testimonial.attribution,
          publishedAt: testimonial.created_at,
          placement,
          ...(rank === undefined ? {} : { featuredRank: rank }),
        };
      });
      return {
        items,
        // Whether anybody has ever picked. `false` means the site is still
        // showing everything published, newest first — which the screen
        // says out loud rather than leaving the principal to infer it from
        // a page of "not shown" rows that are, in fact, shown.
        curated: curation !== undefined,
        maxFeatured: MAX_FEATURED_TESTIMONIALS,
      };
    };

    const readView = async () =>
      viewOf(
        ...((await Promise.all([
          deps.repository.findPublished(),
          deps.repository.readCuration(),
        ])) as [Testimonial[], TestimonialCuration | undefined]),
      );

    if (routeKey === READ_ROUTE) {
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      return respond(200, await readView());
    }

    if (routeKey === SAVE_ROUTE) {
      // `create` and `update` both, for the reason `PUT /testimonials/mine`
      // gives: the first save creates the record and the caller neither
      // knows nor needs to know whether theirs is the first.
      if (
        !can(principal, 'create', resource).allowed ||
        !can(principal, 'update', resource).allowed
      ) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      const parsed = picksSchema.safeParse(parseJsonBody(event));
      if (!parsed.success) {
        return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
      }
      const { featured, listed } = parsed.data;

      if (hasDuplicates(featured) || hasDuplicates(listed)) {
        return respond(400, { error: 'DUPLICATE_TESTIMONIAL' });
      }
      // A testimonial is on the landing page *and* the testimonials page,
      // or on the page only, or nowhere — never named twice. Rejected
      // rather than silently resolved in favour of `featured`, because a
      // caller that sent both did not mean either.
      const overlap = featured.filter((id) => listed.includes(id));
      if (overlap.length > 0) {
        return respond(400, { error: 'DUPLICATE_TESTIMONIAL' });
      }

      // Every pick must name a testimonial that is published *now*. The
      // public read intersects with published anyway, so this cannot
      // protect the page — what it protects is the principal, who would
      // otherwise save a selection and be told nothing about the pick that
      // quietly did nothing.
      const published = await deps.repository.findPublished();
      const publishedIds = new Set(published.map((testimonial) => testimonial.id));
      const unknown = [...featured, ...listed].filter((id) => !publishedIds.has(id));
      if (unknown.length > 0) {
        return respond(400, { error: 'UNKNOWN_TESTIMONIAL' });
      }

      const saved = await deps.repository.saveCuration(
        actorFromPrincipal(principal, requestOriginOf(event)),
        { featured, listed },
      );
      // The record just written, not a re-read of it: nothing else writes
      // this record, so a second GetItem could only return what is already
      // in hand.
      return respond(200, viewOf(published, saved));
    }

    return respond(404, { error: 'NOT_FOUND' });
  };
}
