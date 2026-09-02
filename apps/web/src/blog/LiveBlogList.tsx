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
import { Card, Heading, Link } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { blogContentType, contentApiUrl } from '../site-config.js';

export interface LiveBlogPost {
  readonly id: string;
  readonly translations: Readonly<
    Record<string, { readonly title: string; readonly excerpt: string } | undefined>
  >;
}

export interface LiveBlogListStrings {
  readonly empty: string;
  readonly readMore: string;
}

export interface LiveBlogListProps {
  readonly strings: LiveBlogListStrings;
  readonly locale: string;
  /** The build-time list, rendered into the HTML and used as the seed. */
  readonly initialPosts: readonly LiveBlogPost[];
  readonly fetchPosts?: () => Promise<readonly LiveBlogPost[] | undefined>;
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

/** A post appears on a locale's listing only once it has a translation for it. */
export function postsForLocale(
  posts: readonly LiveBlogPost[],
  locale: string,
): readonly { readonly post: LiveBlogPost; readonly title: string; readonly excerpt: string }[] {
  return posts.flatMap((post) => {
    const translation = post.translations[locale];
    return translation
      ? [{ post, title: translation.title, excerpt: translation.excerpt }]
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

  const entries = postsForLocale(posts, locale);

  if (entries.length === 0) {
    return <p>{strings.empty}</p>;
  }

  return (
    <>
      {entries.map(({ post, title, excerpt }) => (
        <Card key={post.id}>
          <Heading level={2}>{title}</Heading>
          <p>{excerpt}</p>
          <Link href={hrefFor(locale, post.id, prerendered)}>{strings.readMore}</Link>
        </Card>
      ))}
    </>
  );
}
