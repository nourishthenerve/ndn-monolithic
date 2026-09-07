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
import { publicationDateOf } from '../publication-date.js';
import { blogContentType, contentApiUrl } from '../site-config.js';

import { readingMinutes } from './reading-time.js';

export interface LiveBlogPost {
  readonly id: string;
  /** 2026-09-07: the byline date. See `publication-date.ts` for why there are two fields and why both are optional. */
  readonly publishedAt?: string;
  readonly created_at?: string;
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
  /** The build-time list, rendered into the HTML and used as the seed. */
  readonly initialPosts: readonly LiveBlogPost[];
  readonly fetchPosts?: () => Promise<readonly LiveBlogPost[] | undefined>;
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
  initialPosts,
  fetchPosts = defaultFetchPosts,
  limit,
  headingLevel = 2,
}: LiveBlogListProps): ReactNode {
  const [posts, setPosts] = useState<readonly LiveBlogPost[]>(initialPosts);
  const prerendered = prerenderedIds(initialPosts);

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

  const entries = takeAtMost(postsForLocale(posts, locale), limit);

  if (entries.length === 0) {
    return <p>{strings.empty}</p>;
  }

  return (
    <>
      {entries.map(({ post, title, excerpt, body }) => {
        const published = publishedLine(post, strings.publishedOnTemplate, locale);
        const reading = readingTimeLine(body, strings.readingTimeTemplate);
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
            {(published || reading) && (
              <p className="ndn-card-meta">
                {published && <time dateTime={published.iso}>{published.text}</time>}
                {published && reading ? ' · ' : ''}
                {reading}
              </p>
            )}
            <p>{excerpt}</p>
            <Link href={hrefFor(locale, post.id, prerendered)}>{strings.readMore}</Link>
          </Card>
        );
      })}
    </>
  );
}
