// TASK 1.1.3: the single source both the CI a11y/keyboard suite
// (tests/pr-env/a11y-full.test.ts, keyboard.test.ts) and any future
// sitemap read from — a page that forgets to register itself here
// silently skips the a11y gate instead of failing loudly. Every task from
// 1.2.x onward that adds a public page must append its path segment to
// `routeSegments` as part of that task's own DoD.
//
// **2026-09-06: this is no longer also the nav list.** Until now each entry
// could carry a `navLabelKey`, and `Nav.astro` built primary navigation by
// filtering for it. The site is now a single page (`pages/[locale]/index.astro`)
// whose header offers one control — sign in — and nothing else, so there is
// no list of nav-worthy routes left to express. `about` and `services` are
// gone from this file entirely, because their pages are: that copy is now
// `#about` and `#services` on the landing page. The rest stay registered.
// They are still real, reachable pages — the blog and workshop archives the
// homepage links out to, the testimonials page, contact, and the five legal
// documents in the footer — and every one of them still has to clear the
// a11y gate whether or not anything in a header points at it.
import { supportedLocales } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';

import { legalPages } from './config/legal-pages.js';

export interface RouteEntry {
  readonly locale: Locale;
  /** Absolute path including the locale prefix, e.g. `/en` or `/en/blog`. */
  readonly path: string;
}

interface RouteSegment {
  /** Relative to a locale prefix; '' means the locale index itself (`/en`). No leading or trailing slash. */
  readonly segment: string;
}

const routeSegments: readonly RouteSegment[] = [
  // The landing page — about, services, the three most recent blog posts and
  // workshops, and three testimonials, all on one route.
  { segment: '' },
  // TASK 1.3.2: only the fixed listing page, not individual posts —
  // `blog/[slug].astro`'s pages are generated per published post
  // (getStaticPaths, apps/web/src/blog/content-client.ts) and don't have a
  // stable id known ahead of any content existing, so they can't be listed
  // here the way a fixed route can.
  { segment: 'blog' },
  // TASK 1.5.1: only the fixed listing page, same reasoning as 'blog'
  // above — `workshops/[slug].astro`'s pages are generated per published
  // workshop (getStaticPaths, apps/web/src/workshops/workshop-client.ts)
  // and don't have a stable id known ahead of any workshop existing.
  { segment: 'workshops' },
  { segment: 'testimonials' },
  { segment: 'contact' },
  // TASK 1.2.2: legal pages are linked from Footer.astro, and registered
  // here so 1.1.3's a11y/keyboard gate covers them. Derived from
  // legal-pages.ts rather than listed by hand, so the two configs can't
  // drift apart.
  ...legalPages.map((page): RouteSegment => ({ segment: `legal/${page.slug}` })),
];

export const routes: readonly RouteEntry[] = supportedLocales.flatMap((locale) =>
  routeSegments.map(({ segment }) => ({
    locale,
    path: segment === '' ? `/${locale}` : `/${locale}/${segment}`,
  })),
);
