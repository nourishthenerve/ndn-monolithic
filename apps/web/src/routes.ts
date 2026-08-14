// TASK 1.1.3: the single source both the CI a11y/keyboard suite
// (tests/pr-env/a11y-full.test.ts, keyboard.test.ts) and any future
// sitemap read from — a page that forgets to register itself here
// silently skips the a11y gate instead of failing loudly. Every task from
// 1.2.x onward that adds a public page must append its path segment to
// `routeSegments` as part of that task's own DoD.
import { supportedLocales } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';

import { legalPages } from './config/legal-pages.js';

export interface RouteEntry {
  readonly locale: Locale;
  /** Absolute path including the locale prefix, e.g. `/en` or `/en/about`. */
  readonly path: string;
  /**
   * i18n key for this route's primary-nav label (TASK 1.2.1's `Nav.astro`
   * reads it). Unset for routes that must pass the a11y gate above but
   * aren't a top-level nav item — e.g. a future blog post or workshop
   * detail page.
   */
  readonly navLabelKey?: string;
}

interface RouteSegment {
  /** Relative to a locale prefix; '' means the locale index itself (`/en`). No leading or trailing slash. */
  readonly segment: string;
  readonly navLabelKey?: string;
}

const routeSegments: readonly RouteSegment[] = [
  { segment: '', navLabelKey: 'nav.home' },
  { segment: 'about', navLabelKey: 'nav.about' },
  { segment: 'services', navLabelKey: 'nav.services' },
  // TASK 1.3.2: only the fixed listing page, not individual posts —
  // `blog/[slug].astro`'s pages are generated per published post
  // (getStaticPaths, apps/web/src/blog/content-client.ts) and don't have a
  // stable id known ahead of any content existing, so they can't be listed
  // here the way a fixed route can. See this file's own navLabelKey comment
  // below for why that's fine for 1.1.3's a11y gate too.
  { segment: 'blog', navLabelKey: 'nav.blog' },
  // TASK 1.5.1: only the fixed listing page, same reasoning as 'blog'
  // above — `workshops/[slug].astro`'s pages are generated per published
  // workshop (getStaticPaths, apps/web/src/workshops/workshop-client.ts)
  // and don't have a stable id known ahead of any workshop existing.
  { segment: 'workshops', navLabelKey: 'nav.workshops' },
  { segment: 'testimonials', navLabelKey: 'nav.testimonials' },
  { segment: 'contact', navLabelKey: 'nav.contact' },
  // TASK 1.2.2: legal pages aren't primary-nav items (no navLabelKey) —
  // they're linked from Footer.astro instead — but still registered here so
  // 1.1.3's a11y/keyboard gate covers them. Derived from legal-pages.ts
  // rather than listed by hand, so the two configs can't drift apart.
  ...legalPages.map((page): RouteSegment => ({ segment: `legal/${page.slug}` })),
];

export const routes: readonly RouteEntry[] = supportedLocales.flatMap((locale) =>
  routeSegments.map(({ segment, navLabelKey }) => ({
    locale,
    path: segment === '' ? `/${locale}` : `/${locale}/${segment}`,
    navLabelKey,
  })),
);
