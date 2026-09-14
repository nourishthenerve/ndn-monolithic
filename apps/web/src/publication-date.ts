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

/** Milliseconds in a day — the unit the "New" window is measured in. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How recent a post or workshop must be to be marked "New" on a card — the
 * owner asked for "less than 30 days from current date".
 */
export const NEW_WINDOW_DAYS = 30;

/**
 * 2026-09-14: whether `iso` — a publication date from `publicationDateOf` — is
 * within the last `withinDays` days of `now`, which is what a card's "New"
 * marker is shown for.
 *
 * `now` is passed in rather than read from the clock here: it is the reader's
 * own current time at render (a build-time "now" would be wrong for a reader
 * looking weeks later — see `LiveBlogList`'s own note on why the marker is
 * decided after mount), and a test can pin it. A missing or unparseable date,
 * or one in the future, is not "recent" — the first because there is nothing
 * to measure, the last because a not-yet-published date is not new, it is
 * wrong.
 */
export function isRecentlyPublished(
  iso: string | undefined,
  now: number,
  withinDays: number = NEW_WINDOW_DAYS,
): boolean {
  if (!iso) {
    return false;
  }
  const published = Date.parse(iso);
  if (Number.isNaN(published)) {
    return false;
  }
  const age = now - published;
  return age >= 0 && age < withinDays * DAY_MS;
}
