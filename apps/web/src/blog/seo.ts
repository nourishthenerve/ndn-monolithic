// TASK 1.3.2 step 4: "emit <link rel="alternate" hreflang="{locale}"> +
// x-default per published translation actually present — a single-locale
// post emits exactly one tag." x-default only earns its place once there's
// a real choice to default *among* — a single-locale post pointing
// hreflang="x-default" at the same URL as its own hreflang="en" tag would
// be a redundant duplicate, not a fallback.
import { defaultLocale } from '@ndn/i18n';

export interface HreflangLink {
  readonly hreflang: string;
  readonly href: string;
}

export function buildHreflangLinks(
  locales: readonly string[],
  urlForLocale: (locale: string) => string,
): HreflangLink[] {
  const sortedLocales = [...locales].sort();
  const links = sortedLocales.map((locale) => ({ hreflang: locale, href: urlForLocale(locale) }));

  if (sortedLocales.length < 2) {
    return links;
  }

  const [firstLocale] = sortedLocales;
  const defaultTarget = sortedLocales.includes(defaultLocale)
    ? defaultLocale
    : (firstLocale ?? defaultLocale);
  return [...links, { hreflang: 'x-default', href: urlForLocale(defaultTarget) }];
}
