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
import { Card, Heading, Link } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { contentApiUrl, workshopPosterUrl } from '../site-config.js';

export interface LiveWorkshop {
  readonly id: string;
  readonly dateTimeUtc: string;
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
}

export interface LiveWorkshopListProps {
  readonly strings: LiveWorkshopListStrings;
  readonly locale: string;
  readonly initialWorkshops: readonly LiveWorkshop[];
  readonly fetchWorkshops?: () => Promise<readonly LiveWorkshop[] | undefined>;
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
    return detail
      ? [{ workshop, title: detail.title, description: detail.description }]
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

  const entries = workshopsForLocale(workshops, locale);

  if (entries.length === 0) {
    return <p>{strings.empty}</p>;
  }

  return (
    <>
      {entries.map(({ workshop, title, description }) => {
        // See LiveWorkshop.tsx: guarded on the URL, not the key.
        const posterSrc = workshop.posterKey ? workshopPosterUrl(workshop.posterKey) : undefined;
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
          <Heading level={2}>{title}</Heading>
          <p>{description}</p>
          <Link href={hrefFor(locale, workshop.id, prerendered)}>{strings.viewDetails}</Link>
        </Card>
        );
      })}
    </>
  );
}
