// 2026-09-02: the workshops half of the `?slug=` fallback page — one
// prerendered page per locale that can render *any* published workshop,
// resolved in the browser.
//
// `blog/LiveBlogPost.tsx`'s header carries the full reasoning; the short
// version is that a workshop published after the last build has no file on
// S3 to serve, so its own URL is a 404 and there is no server to render it
// on demand. This page always exists.
//
// Like its blog counterpart it is `noIndex` and is never the link for a
// workshop that has a prerendered page of its own.
import { Heading } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { contentApiUrl, workshopPosterUrl } from '../site-config.js';

export interface LiveWorkshopRecord {
  readonly id: string;
  readonly dateTimeUtc: string;
  readonly posterKey?: string;
  readonly details: Readonly<
    Record<string, { readonly title: string; readonly description: string } | undefined>
  >;
}

type ViewState = 'loading' | 'ready' | 'notFound' | 'error';

export interface LiveWorkshopStrings {
  readonly loading: string;
  readonly notFound: string;
  readonly error: string;
  readonly dateLabel: string;
  readonly posterAltTemplate: string;
}

export interface LiveWorkshopProps {
  readonly strings: LiveWorkshopStrings;
  readonly locale: string;
  /** Injectable for tests; defaults to `?slug=` on the current URL. */
  readonly slug?: string;
  readonly fetchWorkshops?: () => Promise<readonly LiveWorkshopRecord[] | undefined>;
}

/**
 * The same `Intl.DateTimeFormat` shape `[slug].astro` uses at build time.
 * Kept identical on purpose: a workshop rendered here and the same one
 * rendered from its prerendered page after the next deploy must not show
 * its time two different ways.
 */
export function formatWorkshopDate(dateTimeUtc: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(
    new Date(dateTimeUtc),
  );
}

function slugFromLocation(): string {
  if (typeof window === 'undefined') {
    return '';
  }
  return new URLSearchParams(window.location.search).get('slug') ?? '';
}

async function defaultFetchWorkshops(): Promise<readonly LiveWorkshopRecord[] | undefined> {
  try {
    const response = await fetch(`${contentApiUrl}/workshops`);
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { items?: readonly LiveWorkshopRecord[] };
    return payload.items;
  } catch {
    return undefined;
  }
}

export function LiveWorkshop({
  strings,
  locale,
  slug,
  fetchWorkshops = defaultFetchWorkshops,
}: LiveWorkshopProps): ReactNode {
  const id = slug ?? slugFromLocation();
  const [state, setState] = useState<ViewState>('loading');
  const [record, setRecord] = useState<LiveWorkshopRecord | undefined>();

  useEffect(() => {
    if (!id) {
      setState('notFound');
      return;
    }
    let cancelled = false;
    void fetchWorkshops().then((workshops) => {
      if (cancelled) {
        return;
      }
      if (!workshops) {
        setState('error');
        return;
      }
      // The read endpoint returns published workshops only, so a
      // cancelled or unpublished one looks the same as a nonexistent one —
      // which is what the prerendered 404 already does for those.
      const found = workshops.find((workshop) => workshop.id === id);
      if (!found?.details[locale]) {
        setState('notFound');
        return;
      }
      setRecord(found);
      setState('ready');
    });
    return () => {
      cancelled = true;
    };
  }, [fetchWorkshops, id, locale]);

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
  const detail = record?.details[locale];
  if (state === 'error' || !record || !detail) {
    return <p role="alert">{strings.error}</p>;
  }

  // 2026-09-02: guarded on the *URL* rather than the key. `mediaUrl`
  // (via `workshopPosterUrl`) answers undefined for a key outside the
  // public `media/` prefix, so a record naming something private renders
  // nothing instead of a link to it.
  const posterSrc = record.posterKey ? workshopPosterUrl(record.posterKey) : undefined;

  return (
    <article>
      {posterSrc && (
        <img
          src={posterSrc}
          alt={strings.posterAltTemplate.replace('{title}', detail.title)}
        />
      )}
      <Heading level={1}>{detail.title}</Heading>
      <p>{detail.description}</p>
      <dl>
        <dt>{strings.dateLabel}</dt>
        <dd>{formatWorkshopDate(record.dateTimeUtc, locale)}</dd>
      </dl>
    </article>
  );
}
