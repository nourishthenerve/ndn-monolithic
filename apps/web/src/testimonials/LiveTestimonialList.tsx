// 2026-09-03: *"it published testimonial by logging in as patient but then
// when I went to testimonial page it's empty."*
//
// ADR-0017 makes this site statically generated, so the listing was built
// from one fetch at `astro build` time and a testimonial published
// afterwards simply was not in it. Correct by design, and not what anyone
// wants from a publish button — the identical problem `LiveBlogList.tsx`
// solved for blog posts on 2026-09-02, and this is the identical answer.
//
// It should have been done then. Testimonials became a thing a patient
// publishes on 2026-09-02, in the same change that removed the moderation
// step; that is exactly when "published" started meaning "immediately",
// and this list stayed on build-time data anyway.
//
// ## The shape
//
// The build-time list is still rendered **server-side into the HTML**, and
// this island is seeded with it, for the three reasons `LiveBlogList`'s own
// header sets out at length:
//
//   * **SEO** — testimonials are a marketing surface, and a crawler that
//     does not run JavaScript must still see them.
//   * **No flash of empty** — the page paints with content, then reconciles.
//   * **It still works with the API down** — an unreachable API leaves the
//     build-time list exactly as it was, the same failure mode
//     `testimonial-client.ts` already chose for the build.
//
// So the fetch is a *reconciliation*, not the source of truth: whatever it
// returns replaces the seed, and whatever it fails to return leaves the
// seed alone.
//
// Simpler than the blog's version in one way that is worth noting: a
// testimonial has no page of its own and no link, so there is no
// prerendered-versus-not asymmetry to carry. A quote either shows or it
// does not.
import { Card } from '@ndn/ui';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { contentApiUrl } from '../site-config.js';

export interface LiveTestimonial {
  readonly quote: Readonly<Record<string, string>>;
  readonly attribution: {
    readonly display: 'full' | 'firstNameOnly' | 'anonymous';
    readonly name?: string;
  };
}

export interface LiveTestimonialListStrings {
  readonly empty: string;
  /** What to show instead of a name when the author chose anonymity. */
  readonly anonymous: string;
}

export interface LiveTestimonialListProps {
  readonly strings: LiveTestimonialListStrings;
  readonly locale: string;
  /** The build-time list, rendered into the HTML and used as the seed. */
  readonly initialTestimonials: readonly LiveTestimonial[];
  readonly fetchTestimonials?: () => Promise<readonly LiveTestimonial[] | undefined>;
}

/**
 * The credit line. `anonymous` never shows a name even if the record
 * carries one — the same rule `toPublicTestimonial` enforces server-side,
 * repeated here because this is the last place before it reaches a reader.
 */
export function attributionLabel(
  testimonial: LiveTestimonial,
  anonymousLabel: string,
): string {
  if (testimonial.attribution.display === 'anonymous') {
    return anonymousLabel;
  }
  return testimonial.attribution.name ?? anonymousLabel;
}

/** The quote in this locale, or the first one written — a testimonial with text is never hidden for want of a translation. */
export function quoteFor(testimonial: LiveTestimonial, locale: string): string | undefined {
  return testimonial.quote[locale] ?? Object.values(testimonial.quote)[0];
}

async function defaultFetchTestimonials(): Promise<readonly LiveTestimonial[] | undefined> {
  try {
    // The same URL `testimonial-client.ts` uses at build time, so the two
    // lists can never disagree about what "the testimonials" means.
    const response = await fetch(`${contentApiUrl}/testimonials`);
    if (!response.ok) {
      return undefined;
    }
    const payload = (await response.json()) as { items?: readonly LiveTestimonial[] };
    return payload.items;
  } catch {
    // The build-time list stays on screen — see this file's header.
    return undefined;
  }
}

export function LiveTestimonialList({
  strings,
  locale,
  initialTestimonials,
  fetchTestimonials = defaultFetchTestimonials,
}: LiveTestimonialListProps): ReactNode {
  const [testimonials, setTestimonials] =
    useState<readonly LiveTestimonial[]>(initialTestimonials);

  useEffect(() => {
    let cancelled = false;
    void fetchTestimonials().then((fetched) => {
      // `undefined` means the fetch failed; an empty array means the
      // practice genuinely has none. Those are different, and only the
      // second should clear the page.
      if (!cancelled && fetched) {
        setTestimonials(fetched);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchTestimonials]);

  const withText = testimonials.flatMap((testimonial) => {
    const quote = quoteFor(testimonial, locale);
    return quote ? [{ testimonial, quote }] : [];
  });

  if (withText.length === 0) {
    return <p>{strings.empty}</p>;
  }

  return (
    <>
      {withText.map(({ testimonial, quote }, index) => (
        <Card key={`${index}-${quote.slice(0, 32)}`}>
          <blockquote>
            <p>{quote}</p>
            <footer>{attributionLabel(testimonial, strings.anonymous)}</footer>
          </blockquote>
        </Card>
      ))}
    </>
  );
}
