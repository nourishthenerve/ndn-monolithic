// 2026-09-02: one page that can render *any* published post, resolved in
// the browser from `?slug=`.
//
// It exists because of what static output cannot do. A post published
// after the last build has no prerendered file on S3, so its own
// `/{locale}/blog/{id}` URL is a 404 — there is no server to render it on
// demand. This page *is* prerendered (one per locale, no `getStaticPaths`
// fan-out), so it always exists, and it fetches the post it was asked for.
//
// **It is the fallback, never the canonical URL.** `LiveBlogList` sends a
// post here only while it has no page of its own; at the next deploy the
// post is prerendered, the rebuilt list links to the real URL, and this
// page stops being used for it. That is why there is no `canonicalHref`
// and no hreflang here and why the page carries `noindex`: two indexable
// URLs for one article is the problem this shape could easily create, and
// the prerendered one is the one that should win.
import { Heading } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { blogContentType, contentApiUrl } from '../site-config.js';

interface Translation {
  readonly title: string;
  readonly body: string;
  readonly excerpt: string;
}

export interface LiveBlogPostRecord {
  readonly id: string;
  readonly translations: Readonly<Record<string, Translation | undefined>>;
}

type ViewState = 'loading' | 'ready' | 'notFound' | 'error';

export interface LiveBlogPostStrings {
  readonly loading: string;
  readonly notFound: string;
  readonly error: string;
}

export interface LiveBlogPostProps {
  readonly strings: LiveBlogPostStrings;
  readonly locale: string;
  /** Injectable for tests; defaults to `?slug=` on the current URL. */
  readonly slug?: string;
  readonly fetchPosts?: () => Promise<readonly LiveBlogPostRecord[] | undefined>;
}

/** Paragraphs are blank-line separated — the same split `[slug].astro` does at build time, so both renderings break identically. */
export function toParagraphs(body: string): readonly string[] {
  return body.split(/\n{2,}/);
}

function slugFromLocation(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('slug') ?? '';
}

async function defaultFetchPosts(): Promise<readonly LiveBlogPostRecord[] | undefined> {
  try {
    const response = await fetch(
      `${contentApiUrl}/content?keyword=${encodeURIComponent(blogContentType)}`,
    );
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { items?: readonly LiveBlogPostRecord[] };
    return payload.items;
  } catch {
    return undefined;
  }
}

export function LiveBlogPost({
  strings,
  locale,
  slug,
  fetchPosts = defaultFetchPosts,
}: LiveBlogPostProps): ReactNode {
  const id = slug ?? slugFromLocation();
  const [state, setState] = useState<ViewState>('loading');
  const [translation, setTranslation] = useState<Translation | undefined>();

  useEffect(() => {
    if (!id) {
      setState('notFound');
      return;
    }
    let cancelled = false;
    void fetchPosts().then((posts) => {
      if (cancelled) {
        return;
      }
      if (!posts) {
        setState('error');
        return;
      }
      // The read endpoint returns published posts only, so "not in this
      // list" covers both "no such post" and "not published" — and both
      // should look the same to a reader, which is what the prerendered
      // 404 already does for an unpublished slug.
      const found = posts.find((post) => post.id === id)?.translations[locale];
      if (!found) {
        setState('notFound');
        return;
      }
      setTranslation(found);
      setState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPosts, id, locale]);

  if (state === 'loading') {
    return (
      <p role="status" aria-live="polite">
        {strings.loading}
      </p>
    );
  }
  if (state === 'notFound') {
    return <p role="alert">{strings.notFound}</p>;
  }
  if (state === 'error' || !translation) {
    return <p role="alert">{strings.error}</p>;
  }

  return (
    <article>
      <Heading level={1}>{translation.title}</Heading>
      {toParagraphs(translation.body).map((paragraph, index) => (
        <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
      ))}
    </article>
  );
}
