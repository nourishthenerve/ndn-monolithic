// 2026-09-02: the workshops half of "I want them to go live immediately."
//
// Same shape as `blog/LiveBlogList.tsx`, and its header carries the full
// reasoning — the build-time list is rendered into the HTML and used as
// the seed, the fetch reconciles on top of it, and a workshop published
// since the last deploy links to the `?slug=` fallback page because it has
// no prerendered page of its own yet.
//
// Kept as a separate component rather than generalised with the blog one.
// The two look alike today and are not the same thing: a workshop carries
// a poster image and a date, a post carries an excerpt and a body, and
// their list items already diverge. A shared generic would have to be
// parameterised on the card's whole contents, which is most of the
// component — the duplication here is the two `useEffect`s and nothing
// else.
import { formatDayMonthYear } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { Card, Heading, Link } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { takeAtMost } from '../list-limit.js';
import { publicationDateOf } from '../publication-date.js';
import { richTextToPlainText } from '../rich-text/render.js';
import { contentApiUrl, workshopPosterUrl } from '../site-config.js';

import { workshopTimesFor } from './workshop-date.js';
import type { WorkshopTimeZoneKey } from './workshop-date.js';

export interface LiveWorkshop {
  readonly id: string;
  readonly dateTimeUtc: string;
  /**
   * 2026-09-07: when the workshop was **announced**, which is not
   * `dateTimeUtc` above and is labelled so on the card. See
   * `publication-date.ts`.
   */
  readonly publishedAt?: string;
  readonly created_at?: string;
  readonly posterKey?: string;
  readonly details: Readonly<
    Record<string, { readonly title: string; readonly description: string } | undefined>
  >;
}

export interface LiveWorkshopListStrings {
  readonly empty: string;
  readonly viewDetails: string;
  /** Rendered with the workshop's own title substituted — see `posterAltFor`. */
  readonly posterAltTemplate: string;
  /** 2026-09-07: `"Announced {date}"`, filled here for the same reason `posterAltTemplate` is. */
  readonly publishedOnTemplate: string;
  /**
   * 2026-09-07: the heading over the three times — the owner: *"For workshop
   * cards show when the workshop is actually happening."*
   *
   * The card carries two kinds of date and this is the one a reader is
   * looking for, so it goes first and says what it is. The announcement
   * date below is context for it.
   */
  readonly happeningLabel: string;
  /** One label per region, keyed as `workshop-date.ts` keys them. The times themselves are formatted there. */
  readonly zoneLabels: Readonly<Record<WorkshopTimeZoneKey, string>>;
}

export interface LiveWorkshopListProps {
  readonly strings: LiveWorkshopListStrings;
  readonly locale: Locale;
  readonly initialWorkshops: readonly LiveWorkshop[];
  readonly fetchWorkshops?: () => Promise<readonly LiveWorkshop[] | undefined>;
  /** 2026-09-06: the homepage's "next three" strip. See `LiveBlogList`'s own `limit` for why this is applied after the reconciliation, not to the seed. */
  readonly limit?: number;
  /** Level for each workshop's title — 3 on the homepage, where a `<h2>` section heading already sits above them. See `LiveBlogList`. */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6;
}

/**
 * `@ndn/i18n`'s `t()` runs at build time in the surrounding page, so the
 * interpolated alt text cannot be produced there for a workshop the build
 * has never seen. The template comes through as a string with the same
 * `{title}` placeholder the catalogue uses, and is filled here.
 */
export function posterAltFor(template: string, title: string): string {
  return template.replace('{title}', title);
}

/**
 * The "announced on" line, or `undefined` when the record carries no
 * timestamp — see `publicationDateOf`.
 *
 * **Announced, not "published", and not the workshop's own date.** A card
 * that showed one bare date would be read as the date of the workshop, and
 * this one is not; the label is what keeps the two apart.
 */
export function announcedLine(
  workshop: LiveWorkshop,
  template: string,
  locale: Locale,
): { readonly iso: string; readonly text: string } | undefined {
  const iso = publicationDateOf(workshop);
  return iso
    ? { iso, text: template.replace('{date}', formatDayMonthYear(iso, locale)) }
    : undefined;
}

export function prerenderedIds(initial: readonly LiveWorkshop[]): ReadonlySet<string> {
  return new Set(initial.map((workshop) => workshop.id));
}

export function hrefFor(
  locale: string,
  workshopId: string,
  prerendered: ReadonlySet<string>,
): string {
  return prerendered.has(workshopId)
    ? `/${locale}/workshops/${workshopId}`
    : `/${locale}/workshops/workshop?slug=${encodeURIComponent(workshopId)}`;
}

export function workshopsForLocale(
  workshops: readonly LiveWorkshop[],
  locale: string,
): readonly {
  readonly workshop: LiveWorkshop;
  readonly title: string;
  readonly description: string;
}[] {
  return workshops.flatMap((workshop) => {
    const detail = workshop.details[locale];
    // 2026-09-06: a description is markup now, and a card is one line of
    // summary text. Flattened rather than rendered: a card is not the place
    // for a heading, a table or an image, and printing the tags as characters
    // is the other thing that would have happened here.
    return detail
      ? [{ workshop, title: detail.title, description: richTextToPlainText(detail.description) }]
      : [];
  });
}

async function defaultFetchWorkshops(): Promise<readonly LiveWorkshop[] | undefined> {
  try {
    const response = await fetch(`${contentApiUrl}/workshops`);
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { items?: readonly LiveWorkshop[] };
    return payload.items;
  } catch {
    return undefined;
  }
}

export function LiveWorkshopList({
  strings,
  locale,
  initialWorkshops,
  fetchWorkshops = defaultFetchWorkshops,
  limit,
  headingLevel = 2,
}: LiveWorkshopListProps): ReactNode {
  const [workshops, setWorkshops] = useState<readonly LiveWorkshop[]>(initialWorkshops);
  const prerendered = prerenderedIds(initialWorkshops);

  useEffect(() => {
    let cancelled = false;
    void fetchWorkshops().then((live) => {
      if (!cancelled && live) {
        setWorkshops(live);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchWorkshops]);

  const entries = takeAtMost(workshopsForLocale(workshops, locale), limit);

  if (entries.length === 0) {
    return <p>{strings.empty}</p>;
  }

  return (
    <>
      {entries.map(({ workshop, title, description }) => {
        // See LiveWorkshop.tsx: guarded on the URL, not the key.
        const posterSrc = workshop.posterKey ? workshopPosterUrl(workshop.posterKey) : undefined;
        const announced = announcedLine(workshop, strings.publishedOnTemplate, locale);
        const times = workshopTimesFor(workshop.dateTimeUtc, locale);
        return (
        <Card key={workshop.id}>
          {posterSrc && (
            <img
              src={posterSrc}
              alt={posterAltFor(strings.posterAltTemplate, title)}
              width="320"
              loading="lazy"
            />
          )}
          <Heading level={headingLevel}>{title}</Heading>
          {/* The workshop's own date first: it is what someone reading a
              workshop card is looking for, and the announcement date is
              context for it. Both are labelled, because two bare dates on
              one card are two chances to read the wrong one.

              A `<dl>`, because region-to-time is exactly what a description
              list is: three `<p>`s would leave a screen reader to infer the
              pairing from the punctuation. One `<time>` per row, each with
              the same instant — the text differs by zone, the moment does
              not. */}
          <p className="ndn-card-meta">{strings.happeningLabel}</p>
          <dl className="ndn-card-times">
            {times.map((time) => (
              <div key={time.key}>
                <dt>{strings.zoneLabels[time.key]}</dt>
                <dd>
                  <time dateTime={workshop.dateTimeUtc}>{time.text}</time>
                </dd>
              </div>
            ))}
          </dl>
          {announced && (
            <p className="ndn-card-meta">
              <time dateTime={announced.iso}>{announced.text}</time>
            </p>
          )}
          <p>{description}</p>
          <Link href={hrefFor(locale, workshop.id, prerendered)}>{strings.viewDetails}</Link>
        </Card>
        );
      })}
    </>
  );
}
