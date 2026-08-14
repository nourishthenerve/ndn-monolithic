// TASK 1.5.1: the only place apps/web calls the workshop read boundary
// (services/api/src/workshop-repository.ts's createWorkshopReadHandler,
// via infra/src/data-stack.ts's ContentHttpApi — same shared HTTP API
// `contentApiUrl` already points at). Runs at `astro build` time (ADR-0017:
// no SSR), same never-throws-on-a-cold-API pattern as
// apps/web/src/blog/content-client.ts and
// apps/web/src/testimonials/testimonial-client.ts.
import { z } from 'zod';

import { contentApiUrl } from '../site-config.js';

const workshopDetailSchema = z.object({
  title: z.string(),
  description: z.string(),
});

const workshopSchema = z.object({
  id: z.string(),
  dateTimeUtc: z.string(),
  capacity: z.number(),
  priceMinorUnits: z.number(),
  posterKey: z.string().optional(),
  details: z.record(z.string(), workshopDetailSchema),
});

export type Workshop = z.infer<typeof workshopSchema>;

const workshopsResponseSchema = z.object({ items: z.array(workshopSchema) });

/**
 * Every published, not-yet-happened workshop, or `[]` if the API is
 * unreachable (e.g. the ephemeral PR environment, where NdnDataStack isn't
 * deployed at all — see infra/bin/app.ts), off (`workshops.enabled`), or
 * returns something that doesn't parse. Never throws — a build must still
 * succeed with zero workshops.
 */
export async function fetchPublishedWorkshops(): Promise<Workshop[]> {
  try {
    const response = await fetch(`${contentApiUrl}/workshops`);
    if (!response.ok) {
      return [];
    }
    const parsed = workshopsResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.items : [];
  } catch {
    return [];
  }
}
