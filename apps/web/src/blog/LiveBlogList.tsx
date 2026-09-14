// 2026-09-02: "when I submit a blog post or workshop via principal
// clinician and then go to the blog and workshop tab it's still empty. I
// want them to go live immediately."
//
// ADR-0017 makes this site statically generated, so the listing was built
// from one fetch at `astro build` time and a post published afterwards
// simply was not in it. Correct by design, and not what anyone wants from
// a publish button.
//
// ## The shape, and why it is not "just fetch on the client"
//
// The build-time list is still rendered **server-side into the HTML**, and
// this island is seeded with it. That matters for three things a
// fetch-on-mount version would have thrown away:
//
//   * **SEO.** The blog is a marketing surface; a crawler that does not
//     run JavaScript must still see the posts.
//   * **No flash of empty.** The page paints with content, then reconciles.
//   * **It still works with the API down.** An unreachable or flag-off
//     content API leaves the build-time list exactly as it was, which is
//     the same failure mode `content-client.ts` already chose for the
//     build ("never throws — a build must still succeed with zero
//     content").
//
// So the fetch is a *reconciliation*, not the source of truth: whatever it
// returns replaces the seed, and whatever it fails to return leaves the
// seed alone.
//
// ## Two link shapes, on purpose
//
// A post that existed at build time has its own prerendered page at
// `/{locale}/blog/{id}` — real URL, indexed, canonical. A post published
// since does not, and cannot: there is no server to render it and no file
// on S3 to serve. Those link to `/{locale}/blog/post?slug=…`, which is one
// prerendered page that resolves any post client-side.
//
// The asymmetry is deliberate and it is self-healing: at the next deploy
// the new post gets its own page, the rebuilt list links to it normally,
// and the `?slug=` form is simply no longer used for it. The alternative —
// sending *every* post through the query-string page — would trade the
// site's real article URLs for uniformity, which is a bad trade on the one
// surface that exists to be found.
import { formatDayMonthYear } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Card, Heading, Link } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { takeAtMost } from '../list-limit.js';
import { isRecentlyPublished, publicationDateOf } from '../publication-date.js';
import { blogContentType, contentApiUrl } from '../site-config.js';

import { readingMinutes } from './reading-time.js';
import { resolveBlogThemeTags } from './theme-tags.js';

export interface LiveBlogPost {
  readonly id: string;
  /** 2026-09-07: the byline date. See `publication-date.ts` for why there are two fields and why both are optional. */
  readonly publishedAt?: string;
  readonly created_at?: string;
  /**
   * 2026-09-13: the post's theme ids (a subset of `blogThemeIds`), shown as
   * tags on the card. Optional — a post from before the field existed has none
   * — and rendered through `themeLabels`, so an id with no label is skipped
   * rather than shown raw.
   */
  readonly themes?: readonly string[];
  readonly translations: Readonly<
    Record<
      string,
      // 2026-09-07: `body` is what the reading estimate is counted from. It
      // was always in this payload — the content API returns whole records
      // and the page hands the island the same objects it parsed — it was
      // simply not declared here, because until now nothing on a card
      // needed it. Optional so a card still renders if it is ever absent.
      { readonly title: string; readonly excerpt: string; readonly body?: string } | undefined
    >
  >;
}

export interface LiveBlogListStrings {
  readonly empty: string;
  readonly readMore: string;
  /**
   * 2026-09-14: the word on the "New" marker a card carries when its post was
   * published within the last 30 days. Just "New" today; a string so the day a
   * second locale ships it is translated with everything else.
   */
  readonly newLabel: string;
  /**
   * 2026-09-07: `"Published {date}"`, with the placeholder still in it —
   * `t()` runs at build time in the surrounding page and cannot format a
   * date for a post the build has never seen. Same arrangement as
   * `LiveWorkshopList`'s `posterAltTemplate`.
   */
  readonly publishedOnTemplate: string;
  /**
   * 2026-09-07: `"{minutes} min read"`, with the placeholder still in it —
   * the estimate is computed from the body, and a post reconciled in the
   * browser was never seen by the build that ran `t()`.
   */
  readonly readingTimeTemplate: string;
}

export interface LiveBlogListProps {
  readonly strings: LiveBlogListStrings;
  readonly locale: Locale;
  /**
   * 2026-09-13: theme id → label, for the tags on each card. Resolved by the
   * page from the catalogue (the island cannot call `t()`), and covering the
   * whole set so a post reconciled in from a fetch since the last build finds
   * its labels too. Optional — a page that does not pass it shows no tags,
   * which is how a listing opts out.
   */
  readonly themeLabels?: Readonly<Record<string, string>>;
  /** The build-time list, rendered into the HTML and used as the seed. */
  readonly initialPosts: readonly LiveBlogPost[];
  readonly fetchPosts?: () => Promise<readonly LiveBlogPost[] | undefined>;
  /**
   * 2026-09-14: a theme id to narrow the list to — the topic pages
   * (`/blog/topic/{id}`) show only the posts carrying that theme. Applied to
   * both the seed and the reconciled fetch, so a post published since the last
   * build appears under its topic the moment it is live, exactly as it does on
   * the full archive. Unset — every listing but a topic page — shows all posts.
   */
  readonly themeFilter?: string;
  /**
   * 2026-09-14: the build-time instant (ms) the "New" marker is measured
   * against for the server render and the first client paint. Passed by the
   * page as `Date.now()`, so it is a fixed value that serializes into the
   * island and is identical on the server and on hydration — which is what
   * lets the badge be rendered into the HTML (see `nowMs`) rather than only
   * appearing once JavaScript runs. After mount it is refined to the reader's
   * own clock. A test pins it directly. Omitted, the marker simply waits for
   * mount, as it used to.
   */
  readonly now?: number;
  /**
   * 2026-09-06: how many to show, for the homepage's "latest three" strip.
   * Unset — the `/blog` listing — shows everything, so that page is
   * unchanged by this prop existing.
   *
   * Applied **after** the reconciliation below, never to the seed: trimming
   * the seed first would mean a post published since the last deploy could
   * only ever appear by pushing the strip to four, and the whole point of
   * this island is that the fetched list replaces the built one.
   */
  readonly limit?: number;
  /**
   * Level for each post's own title. Defaults to 2, the listing page's
   * shape (`<h1>` page title, `<h2>` per post). The homepage passes 3,
   * because there each post sits under a `<h2>` section heading and an
   * `<h2>` there would make posts siblings of the section rather than its
   * contents.
   */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6;
}

/**
 * Which ids had their own page generated at build time. Anything outside
 * this set has no prerendered URL yet and must use the `?slug=` page.
 *
 * Derived from the seed rather than passed separately, because the seed
 * *is* the build-time list — two sources for one fact could disagree, and
 * the failure would be a link to a 404.
 */
export function prerenderedIds(initialPosts: readonly LiveBlogPost[]): ReadonlySet<string> {
  return new Set(initialPosts.map((post) => post.id));
}

export function hrefFor(
  locale: string,
  postId: string,
  prerendered: ReadonlySet<string>,
): string {
  return prerendered.has(postId)
    ? `/${locale}/blog/${postId}`
    : `/${locale}/blog/post?slug=${encodeURIComponent(postId)}`;
}

/**
 * The byline line for one post, or `undefined` when the record carries no
 * timestamp at all — see `publicationDateOf`. Returned as both the text and
 * the machine-readable instant so the card can render a real `<time>`.
 */
export function publishedLine(
  post: LiveBlogPost,
  template: string,
  locale: Locale,
): { readonly iso: string; readonly text: string } | undefined {
  const iso = publicationDateOf(post);
  return iso
    ? { iso, text: template.replace('{date}', formatDayMonthYear(iso, locale)) }
    : undefined;
}

/**
 * The reading estimate for one post, or `undefined` when there is nothing
 * to estimate from — an image-only post, or a body that did not reach the
 * page. See `reading-time.ts`.
 */
export function readingTimeLine(
  body: string | undefined,
  template: string,
): string | undefined {
  const minutes = readingMinutes(body);
  return minutes === undefined ? undefined : template.replace('{minutes}', String(minutes));
}

/**
 * A post's themes as display labels, in the post's own order, dropping any id
 * `themeLabels` has no entry for — an unknown or retired theme — rather than
 * showing a raw id. Returns `[]` when the post has no themes or the page
 * passed no label map (a listing that opts out of tags).
 *
 * The card's own view of `resolveBlogThemeTags` — that shared helper is what
 * the article pages (`blog/[slug].astro`, `LiveBlogPost`) resolve their tags
 * with too, so a post's tags read identically on the card and in the article.
 */
export function themeTagsFor(
  post: LiveBlogPost,
  themeLabels: Readonly<Record<string, string>> | undefined,
): readonly { readonly id: string; readonly label: string }[] {
  return resolveBlogThemeTags(post.themes, themeLabels);
}

/**
 * The posts newest first, by the date each one tells a reader it went up —
 * `publicationDateOf` (`publishedAt`, or `created_at` for a post from before
 * that field existed). This is the order the owner asked for on both
 * surfaces: the homepage's "latest three" strip and the `/blog` archive, so
 * the newest post is the leftmost card and the top of the list.
 *
 * Sorted here rather than trusting the content API's order, which is
 * unspecified — and sorted *before* `takeAtMost`, so the homepage's three are
 * the three most *recent* and not merely the first three the response
 * happened to carry.
 *
 * A post with neither timestamp (`publicationDateOf` → `undefined`, or an
 * unparseable date) sorts to the end: it has dated posts around it and no
 * claim to the top, so it never displaces a genuine "latest". Posts published
 * in the same instant keep their incoming order — `Array.prototype.sort` is
 * stable (ES2019) — so a real tie is never reshuffled.
 */
export function sortedByPublishedDesc(
  posts: readonly LiveBlogPost[],
): readonly LiveBlogPost[] {
  return [...posts].sort((a, b) => {
    const first = publishedInstant(a);
    const second = publishedInstant(b);
    // Guard the both-dateless case: -Infinity - -Infinity is NaN, and a NaN
    // comparator return is undefined behaviour. Equal instants keep order.
    return first === second ? 0 : second - first;
  });
}

/**
 * A post's publication date as a millisecond instant for comparison, or
 * `-Infinity` when it has no usable date — an absent or unparseable timestamp
 * — which sorts it to the end of a newest-first list.
 */
function publishedInstant(post: LiveBlogPost): number {
  const iso = publicationDateOf(post);
  const instant = iso ? Date.parse(iso) : Number.NaN;
  return Number.isNaN(instant) ? Number.NEGATIVE_INFINITY : instant;
}

/** A post appears on a locale's listing only once it has a translation for it. */
export function postsForLocale(
  posts: readonly LiveBlogPost[],
  locale: string,
): readonly {
  readonly post: LiveBlogPost;
  readonly title: string;
  readonly excerpt: string;
  readonly body?: string;
}[] {
  return posts.flatMap((post) => {
    const translation = post.translations[locale];
    return translation
      ? [
          {
            post,
            title: translation.title,
            excerpt: translation.excerpt,
            body: translation.body,
          },
        ]
      : [];
  });
}

async function defaultFetchPosts(): Promise<readonly LiveBlogPost[] | undefined> {
  try {
    const response = await fetch(
      // The same query `content-client.ts` uses at build time — one
      // parameter name, so the two lists can never disagree about what
      // "the blog" means.
      `${contentApiUrl}/content?keyword=${encodeURIComponent(blogContentType)}`,
    );
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { items?: readonly LiveBlogPost[] };
    return payload.items;
  } catch {
    // The build-time list stays on screen — see this file's header.
    return undefined;
  }
}

export function LiveBlogList({
  strings,
  locale,
  themeLabels,
  initialPosts,
  fetchPosts = defaultFetchPosts,
  themeFilter,
  now,
  limit,
  headingLevel = 2,
}: LiveBlogListProps): ReactNode {
  const [posts, setPosts] = useState<readonly LiveBlogPost[]>(initialPosts);
  const prerendered = prerenderedIds(initialPosts);

  /**
   * The time the "New" window is measured against.
   *
   * Seeded with the build-time `now` the page passed, so the marker is decided
   * during the server render and again identically on the first client paint
   * (same serialized value) — no hydration mismatch, and the badge is in the
   * HTML rather than waiting for JavaScript. This matters: `/blog` is a
   * long-lived URL a reader may load from a stale or slow cache, and the badge
   * has to be there without the island having reconciled yet.
   *
   * After mount it is refined to the reader's *own* clock — a page built weeks
   * ago must not keep calling a now-old post "New" — and that also covers a
   * post reconciled in from the fetch, which the build never saw. With no
   * build-time `now` (a caller that opts out), it simply stays unset until
   * mount, the behaviour this had before.
   */
  const [nowMs, setNowMs] = useState<number | undefined>(now);
  useEffect(() => {
    setNowMs(Date.now());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchPosts().then((live) => {
      if (!cancelled && live) {
        setPosts(live);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPosts]);

  // On a topic page, only the posts carrying that theme; everywhere else, all
  // of them. Filtered before the sort and the limit so a topic strip, if it
  // ever had one, would still show its own most-recent posts.
  const visiblePosts = themeFilter
    ? posts.filter((post) => (post.themes ?? []).includes(themeFilter))
    : posts;
  // Newest first, then trimmed: the homepage's three are the three most
  // recent, and the leftmost card / top of the list is the latest post.
  const entries = takeAtMost(postsForLocale(sortedByPublishedDesc(visiblePosts), locale), limit);

  if (entries.length === 0) {
    return <p>{strings.empty}</p>;
  }

  return (
    <>
      {entries.map(({ post, title, excerpt, body }) => {
        const published = publishedLine(post, strings.publishedOnTemplate, locale);
        const reading = readingTimeLine(body, strings.readingTimeTemplate);
        const tags = themeTagsFor(post, themeLabels);
        // Decided after mount only (see `nowMs`), so it is measured against the
        // reader's clock and never disagrees with the server render.
        const isNew = nowMs !== undefined && isRecentlyPublished(published?.iso, nowMs);
        return (
          <Card key={post.id}>
            <Heading level={headingLevel}>{title}</Heading>
            {/* Directly under the title, where a byline goes, and a real
                `<time>` rather than a `<p>`: the date is machine-readable
                for a crawler, and the site's own formatter renders it in
                the site's locale rather than the reader's browser one
                (`@ndn/i18n`'s datetime.ts). */}
            {/* One line, two facts: when it went up and how long it takes.
                They belong together — both are what a reader weighs before
                clicking — and two stacked lines of grey would crowd a card
                that is mostly excerpt. Separated by a middle dot, and each
                still legible on its own if the other is missing. */}
            {(isNew || published || reading) && (
              <p className="ndn-card-meta">
                {/* A small green capsule, first on the line, for a post
                    published within the last 30 days. Its own element so a
                    screen reader reads the word, and separated from the date
                    by a real space rather than the middle dot the date and
                    reading estimate share. */}
                {isNew && <span className="ndn-new-badge">{strings.newLabel}</span>}
                {isNew && (published || reading) ? ' ' : ''}
                {published && <time dateTime={published.iso}>{published.text}</time>}
                {published && reading ? ' · ' : ''}
                {reading}
              </p>
            )}
            <p>{excerpt}</p>
            {/* The post's themes, as tags. A list because it is one — and
                below the excerpt, where a reader looks after deciding the
                post is roughly relevant, not before reading what it is. */}
            {tags.length > 0 && (
              <ul className="ndn-card-themes">
                {tags.map((tag) => (
                  <li key={tag.id} className="ndn-tag">
                    {tag.label}
                  </li>
                ))}
              </ul>
            )}
            <Link href={hrefFor(locale, post.id, prerendered)}>{strings.readMore}</Link>
          </Card>
        );
      })}
    </>
  );
}
