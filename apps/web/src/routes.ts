// TASK 1.1.3: the single source both the CI a11y/keyboard suite
// (tests/pr-env/a11y-full.test.ts, keyboard.test.ts) and any future
// sitemap read from — a page that forgets to register itself here
// silently skips the a11y gate instead of failing loudly. Every task from
// 1.2.x onward that adds a public page must append its path segment to
// `routeSegments` as part of that task's own DoD.
import { supportedLocales } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';

export interface RouteEntry {
  readonly locale: Locale;
  /** Absolute path including the locale prefix, e.g. `/en` or `/en/about`. */
  readonly path: string;
}

// Segment relative to a locale prefix; '' means the locale index itself
// (`/en`). No leading or trailing slash.
const routeSegments: readonly string[] = [''];

export const routes: readonly RouteEntry[] = supportedLocales.flatMap((locale) =>
  routeSegments.map((segment) => ({
    locale,
    path: segment === '' ? `/${locale}` : `/${locale}/${segment}`,
  })),
);
