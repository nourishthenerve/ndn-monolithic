// 2026-09-13: the blog's controlled vocabulary of themes. The owner named
// twelve subjects a post can be filed under: *"for blog posts, there are
// around 12 themes that I want to be assigned to a given blog post."*
//
// These are **not** `ContentItem.keywords`. Keywords are free text the author
// types and a GSI2 partition key a reader can search by (see
// content-repository.ts); themes are a fixed, closed set chosen from a
// checklist and shown as tags on each card. Two different jobs, so two
// different fields — a post can carry any of these themes and any keywords at
// once.
//
// The ids live here, in shared-types, so both sides of the boundary agree on
// them from one source: services/api validates an incoming post's `themes`
// against this list (content-authoring.ts), and apps/web renders the checklist
// and the tags from it (config/blog-themes.ts). The human-readable label for
// each id is a `blog.theme.<id>` catalogue entry in packages/i18n — an id is
// language-neutral and stable, a label is neither.
//
// Ordered deliberately: this is the order the checklist and any legend show
// them in, so it is the order the owner listed them in.

/**
 * Every blog theme id, in display order. `as const` so it is a tuple of
 * string literals — `z.enum(blogThemeIds)` on the API side and the
 * `BlogThemeId` union below both need the exact members, not `string[]`.
 */
export const blogThemeIds = [
  'anxiety-stress-nervous-system',
  'neurorehabilitation',
  'pain-science',
  'migraine-headache-nervous-system',
  'stress-management-nervous-system-health',
  'mental-health-and-brain',
  'womens-health',
  'lifestyle-medicine',
  'nutrition-brain-nerve-health',
  'healthy-brain-longevity',
  'child-development-family-health',
  'ask-the-doctor-myth-busting',
] as const;

export type BlogThemeId = (typeof blogThemeIds)[number];

const blogThemeIdSet: ReadonlySet<string> = new Set(blogThemeIds);

/** Narrows an untrusted string to a known theme id — the runtime guard behind the compile-time union. */
export function isBlogThemeId(value: string): value is BlogThemeId {
  return blogThemeIdSet.has(value);
}
