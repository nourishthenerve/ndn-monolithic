import { defaultLocale, t } from '@ndn/i18n';
import { legalPages } from '@ndn/web/legal-pages.js';
import { describe, expect, it } from 'vitest';

import { getBaseUrl } from './env.js';

// TASK 1.2.2: proves the placeholder banner survives in real rendered HTML
// (not just that LegalPage.astro references the component — a build-time
// guard could still ship a page where the banner silently fails to render)
// and that every legal page is actually reachable from the footer.
describe('ephemeral PR environment — legal pages', () => {
  const bannerText = t('legal.placeholderNotice', undefined, defaultLocale);

  for (const page of legalPages) {
    it(`/${defaultLocale}/legal/${page.slug} returns 200 and renders the placeholder banner`, async () => {
      const response = await fetch(`${getBaseUrl()}/${defaultLocale}/legal/${page.slug}`);
      expect(response.status).toBe(200);

      const html = await response.text();
      expect(html).toContain(bannerText);
    });
  }

  it('footer links to every legal page', async () => {
    const response = await fetch(`${getBaseUrl()}/${defaultLocale}`);
    const html = await response.text();

    for (const page of legalPages) {
      expect(html).toContain(`/${defaultLocale}/legal/${page.slug}`);
    }
  });
});
