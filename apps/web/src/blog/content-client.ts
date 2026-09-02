// TASK 1.3.2: the only place apps/web calls the content API
// (services/api/src/content-repository.ts's createContentReadHandler, via
// infra/src/data-stack.ts's ContentHttpApi). Runs at `astro build` time —
// ADR-0017's static output means there is no server and no browser-side
// fetch here, only build-time data fetching (getStaticPaths).
//
// Zod-parsed (00-conventions.md: "Zod for runtime validation at every
// boundary") — this is the one boundary in apps/web that crosses a real
// network call, as opposed to config/legal-pages.ts's eagerly-parsed
// checked-in literal.
import { z } from 'zod';

import { blogContentType, contentApiUrl } from '../site-config.js';

const translationSchema = z.object({
  title: z.string(),
  body: z.string(),
  excerpt: z.string(),
});

const blogPostSchema = z.object({
  id: z.string(),
  keywords: z.array(z.string()),
  // 2026-09-02: the lead image, as a media-bucket key. Optional, and the
  // schema stays tolerant of its absence because every post written
  // before today has none — a stricter shape here would empty the blog.
  imageKey: z.string().optional(),
  translations: z.record(z.string(), translationSchema),
});

export type BlogPost = z.infer<typeof blogPostSchema>;

const contentResponseSchema = z.object({ items: z.array(blogPostSchema) });

/**
 * Every published blog post, or `[]` if the API is unreachable, off
 * (`content.readApi.enabled`), or returns something that doesn't parse.
 * Never throws — a build must still succeed with zero content, which is
 * the normal state for the ephemeral PR environment (infra/bin/app.ts:
 * DataStack isn't deployed there at all) and for local dev.
 */
export async function fetchPublishedBlogPosts(): Promise<BlogPost[]> {
  try {
    const response = await fetch(
      `${contentApiUrl}/content?keyword=${encodeURIComponent(blogContentType)}`,
    );
    if (!response.ok) {
      return [];
    }
    const parsed = contentResponseSchema.safeParse(await response.json());
    return parsed.success ? parsed.data.items : [];
  } catch {
    return [];
  }
}
