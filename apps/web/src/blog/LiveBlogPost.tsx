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
import { formatDayMonthYear } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Heading } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { publicationDateOf } from '../publication-date.js';
import { renderableRichText, toPlainParagraphs } from '../rich-text/render.js';
import { blogContentType, contentApiUrl, mediaUrl } from '../site-config.js';

interface Translation {
  readonly title: string;
  readonly body: string;
  readonly excerpt: string;
}

export interface LiveBlogPostRecord {
  readonly id: string;
  /** 2026-09-02: optional lead image, as a media-bucket key. */
  readonly imageKey?: string;
  /** 2026-09-07: the byline date — see `publication-date.ts`. */
  readonly publishedAt?: string;
  readonly created_at?: string;
  readonly translations: Readonly<Record<string, Translation | undefined>>;
}

type ViewState = 'loading' | 'ready' | 'notFound' | 'error';

export interface LiveBlogPostStrings {
  readonly loading: string;
  readonly notFound: string;
  readonly error: string;
  /**
   * Alt text for the lead image. One string for every post, because the
   * author is never asked to write one — and a generic-but-true
   * description beats an empty `alt` on an image that carries meaning, or
   * a fabricated one that does not describe the picture at all.
   */
  readonly imageAlt: string;
  /** 2026-09-07: `"Published {date}"`, filled here — the build cannot format a date for a post it has never seen. */
  readonly publishedOnTemplate: string;
}

export interface LiveBlogPostProps {
  readonly strings: LiveBlogPostStrings;
  readonly locale: Locale;
  /** Injectable for tests; defaults to `?slug=` on the current URL. */
  readonly slug?: string;
  readonly fetchPosts?: () => Promise<readonly LiveBlogPostRecord[] | undefined>;
}

/**
 * Paragraphs are blank-line separated — the same split `[slug].astro` does at
 * build time, so both renderings break identically.
 *
 * 2026-09-06: the split itself moved to `rich-text/render.ts`, which is now
 * where *both* readings of a body live: this one for plain text, and
 * `renderableRichText` for a post written in the editor. Re-exported under
 * its old name because that is what this module's own tests already call it.
 */
export const toParagraphs = toPlainParagraphs;

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
  const [imageKey, setImageKey] = useState<string | undefined>();
  const [publishedIso, setPublishedIso] = useState<string | undefined>();

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
      const post = posts.find((candidate) => candidate.id === id);
      const found = post?.translations[locale];
      if (!found) {
        setState('notFound');
        return;
      }
      setTranslation(found);
      // Kept beside the translation rather than derived later: the image
      // belongs to the post, not to a language, and the post itself is not
      // held in state.
      setImageKey(post?.imageKey);
      // Same reasoning as the image: a date belongs to the post, not to a
      // language, and the post itself is not held in state.
      setPublishedIso(post ? publicationDateOf(post) : undefined);
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

  // `mediaUrl` answers `undefined` for a key outside the public prefix, so
  // a record naming something private renders no image rather than a link
  // to it. See its own note.
  const image = imageKey ? mediaUrl(imageKey) : undefined;
  // The same question `[slug].astro` asks of the same field, from the same
  // function, so this page and the prerendered one cannot render one post two
  // ways. `undefined` means "not markup, or not markup we can vouch for" and
  // takes the paragraph path this page has always used.
  const bodyHtml = renderableRichText(translation.body);

  return (
    <article>
      <Heading level={1}>{translation.title}</Heading>
      {/* The byline, before the lead image, so it reads as the article's
          own date rather than a caption on the picture. */}
      {publishedIso && (
        <p className="ndn-card-meta">
          <time dateTime={publishedIso}>
            {strings.publishedOnTemplate.replace(
              '{date}',
              formatDayMonthYear(publishedIso, locale),
            )}
          </time>
        </p>
      )}
      {image && <img src={image} alt={strings.imageAlt} />}
      {bodyHtml ? (
        <div className="ndn-prose" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
      ) : (
        toParagraphs(translation.body).map((paragraph, index) => (
          <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
        ))
      )}
    </article>
  );
}
