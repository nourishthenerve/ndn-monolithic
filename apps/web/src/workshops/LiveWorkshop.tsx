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
import { formatDayMonthYear } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Heading } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { publicationDateOf } from '../publication-date.js';
import { renderableRichText, toPlainParagraphs } from '../rich-text/render.js';
import { contentApiUrl, workshopPosterUrl } from '../site-config.js';

import { formatWorkshopDate, workshopTimesFor } from './workshop-date.js';
import type { WorkshopTimeZoneKey } from './workshop-date.js';

// 2026-09-07: `formatWorkshopDate` moved out of this file to
// `workshop-date.ts`, now that the listing cards render the same instant
// too — see that module's own note on why three formatters kept in step by
// hand became one. Re-exported here because this is where it lived, and
// where this module's own test still looks for it.
export { formatWorkshopDate };

export interface LiveWorkshopRecord {
  readonly id: string;
  readonly dateTimeUtc: string;
  /** 2026-09-07: when it was announced — a different fact from `dateTimeUtc`, and a different row in the list below. */
  readonly publishedAt?: string;
  readonly created_at?: string;
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
  /** 2026-09-07: one label per region — the workshop's time is given in all three. */
  readonly zoneLabels: Readonly<Record<WorkshopTimeZoneKey, string>>;
  /** 2026-09-07: the label on the announcement date, beside the three time rows. */
  readonly announcedLabel: string;
  readonly posterAltTemplate: string;
}

export interface LiveWorkshopProps {
  readonly strings: LiveWorkshopStrings;
  readonly locale: Locale;
  /** Injectable for tests; defaults to `?slug=` on the current URL. */
  readonly slug?: string;
  readonly fetchWorkshops?: () => Promise<readonly LiveWorkshopRecord[] | undefined>;
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
  const descriptionHtml = renderableRichText(detail.description);
  const announcedIso = publicationDateOf(record);

  return (
    <article>
      {posterSrc && (
        <img
          src={posterSrc}
          alt={strings.posterAltTemplate.replace('{title}', detail.title)}
        />
      )}
      <Heading level={1}>{detail.title}</Heading>
      {/* The same reading `workshops/[slug].astro` gives the same field, from
          the same function — see `rich-text/render.ts`. */}
      {descriptionHtml ? (
        <div className="ndn-prose" dangerouslySetInnerHTML={{ __html: descriptionHtml }} />
      ) : (
        toPlainParagraphs(detail.description).map((paragraph, index) => (
          <p key={`${index}-${paragraph.slice(0, 24)}`}>{paragraph}</p>
        ))
      )}
      {/* Every row is labelled. The three region times and the announcement
          date are all dates about the same workshop, and the only thing
          keeping them apart for a reader is that each is named. The region
          rows nest their label under the "Date and time" one because they
          are three readings of a single fact, not three facts. */}
      <dl>
        <dt>{strings.dateLabel}</dt>
        <dd>
          <dl>
            {workshopTimesFor(record.dateTimeUtc, locale).map((time) => (
              <div key={time.key}>
                <dt>{strings.zoneLabels[time.key]}</dt>
                <dd>
                  <time dateTime={record.dateTimeUtc}>{time.text}</time>
                </dd>
              </div>
            ))}
          </dl>
        </dd>
        {announcedIso && (
          <>
            <dt>{strings.announcedLabel}</dt>
            <dd>
              <time dateTime={announcedIso}>{formatDayMonthYear(announcedIso, locale)}</time>
            </dd>
          </>
        )}
      </dl>
    </article>
  );
}
