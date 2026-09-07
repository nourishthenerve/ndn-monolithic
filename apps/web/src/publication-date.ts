// 2026-09-07: the date a blog post or a workshop tells a reader it went up.
// The owner: *"for blog post and workshops also show the date of publication
// on the thumbnail box at websites landing page as well as when someone
// clicks read more."*
//
// Written once, in the same spirit as `list-limit.ts`, because the rule has
// a fallback in it and six surfaces render it: the homepage's two strips,
// the two listing pages, the two prerendered detail pages, and the two
// `?slug=` fallback pages. A `?? created_at` repeated across those would be
// eight chances to disagree about the date on the same article.
//
// **The fallback is a migration, not a design.** `publishedAt` is stamped on
// the transition into `published` (`content-repository.ts`,
// `workshop-repository.ts`), so every post and workshop written from today
// carries one. Everything already live predates the field and never will —
// so those fall back to `created_at`, which for them is very close: the
// authoring form has published by default since it was built, so an existing
// post was created and published in the same request.
//
// The fallback is deliberately not "show nothing": a byline with no date on
// an article that plainly has one reads as a defect, and `created_at` is a
// true statement about the record even where it is a day or two early.

/** Anything with the two timestamps a published record carries. Structural on purpose — a blog post and a workshop share no type but share this. */
export interface Publishable {
  readonly publishedAt?: string;
  readonly created_at?: string;
}

/**
 * When to tell a reader this went live, or `undefined` if the record
 * carries neither timestamp.
 *
 * `undefined` is reachable: the two client schemas parse both fields as
 * optional, deliberately, because a schema that *required* a timestamp
 * would fail the whole parse on a response shape it did not expect and
 * empty the page — which is exactly how the testimonials listing broke on
 * 2026-09-03. A missing date renders no date; it never renders a broken
 * list.
 */
export function publicationDateOf(item: Publishable): string | undefined {
  return item.publishedAt ?? item.created_at;
}
