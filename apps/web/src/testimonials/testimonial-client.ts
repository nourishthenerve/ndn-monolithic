// TASK 1.4.2: the only place apps/web calls the testimonial read boundary
// (services/api/src/testimonial-moderation.ts's public `GET /testimonials`
// branch, via infra/src/data-stack.ts's ContentHttpApi — same shared HTTP
// API `contentApiUrl` already points at, testimonials just add routes to
// it). Runs at `astro build` time (ADR-0017: no SSR), same pattern
// apps/web/src/blog/content-client.ts already established — never throws,
// a build must still succeed with zero testimonials.
import { z } from 'zod';

import { contentApiUrl } from '../site-config.js';

const attributionSchema = z.object({
  display: z.enum(['full', 'firstNameOnly', 'anonymous']),
  name: z.string().optional(),
});

// **No `id`** (2026-09-03). `GET /testimonials` projects to the words and
// the credit and nothing else — `testimonial-read.ts`'s
// `toPublicTestimonial` — because a testimonial's id is derived from its
// author's patient id and this is an unauthenticated endpoint.
//
// This schema still required it, so every response failed `safeParse` and
// the page rendered its empty state with a live API returning a real
// testimonial. Found live: a patient published one and the public page
// stayed empty. Nothing caught it because the fixtures in this file's own
// test were written against the old shape and kept an `id`.
const testimonialSchema = z.object({
  quote: z.record(z.string(), z.string()),
  attribution: attributionSchema,
});

export type PublishedTestimonial = z.infer<typeof testimonialSchema>;

const testimonialsResponseSchema = z.object({ items: z.array(testimonialSchema) });

/**
 * Every published testimonial, or `[]` if the API is unreachable (e.g. the
 * ephemeral PR environment, where NdnDataStack isn't deployed at all — see
 * infra/bin/app.ts) or returns something that doesn't parse.
 */
export async function fetchPublishedTestimonials(): Promise<PublishedTestimonial[]> {
  try {
    const response = await fetch(`${contentApiUrl}/testimonials`);
    if (!response.ok) {
      return [];
    }
    const parsed = testimonialsResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.items : [];
  } catch {
    return [];
  }
}
