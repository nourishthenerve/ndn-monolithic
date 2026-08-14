import { describe, expect, it } from 'vitest';

import { buildHreflangLinks } from './seo.js';

const urlForLocale = (locale: string) => `https://next.nourishthenerve.com/${locale}/blog/my-post`;

describe('buildHreflangLinks', () => {
  it('emits exactly one tag for a single-locale post — no redundant x-default', () => {
    const links = buildHreflangLinks(['en'], urlForLocale);
    expect(links).toEqual([
      { hreflang: 'en', href: 'https://next.nourishthenerve.com/en/blog/my-post' },
    ]);
  });

  it('emits one tag per locale plus x-default when 2+ locales are populated', () => {
    const links = buildHreflangLinks(['fr', 'en'], urlForLocale);
    expect(links).toEqual([
      { hreflang: 'en', href: 'https://next.nourishthenerve.com/en/blog/my-post' },
      { hreflang: 'fr', href: 'https://next.nourishthenerve.com/fr/blog/my-post' },
      { hreflang: 'x-default', href: 'https://next.nourishthenerve.com/en/blog/my-post' },
    ]);
  });

  it('points x-default at the first locale alphabetically when the default locale is absent', () => {
    const links = buildHreflangLinks(['fr', 'de'], urlForLocale);
    expect(links).toContainEqual({
      hreflang: 'x-default',
      href: 'https://next.nourishthenerve.com/de/blog/my-post',
    });
  });

  it('returns an empty array for a post with no translations', () => {
    expect(buildHreflangLinks([], urlForLocale)).toEqual([]);
  });
});
