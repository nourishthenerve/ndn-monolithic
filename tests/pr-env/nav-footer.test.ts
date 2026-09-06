import { defaultLocale } from '@ndn/i18n';
import { legalPages } from '@ndn/web/legal-pages.js';
import { routes } from '@ndn/web/routes.js';
import { socialLinks } from '@ndn/web/social-links.js';
import { describe, expect, it } from 'vitest';

import { getBaseUrl } from './env.js';

// TASK 1.2.1: originally "nav links to every route routes.ts marks as
// nav-worthy" — proving each registered nav item was actually reachable
// (200), not merely present in markup.
//
// **2026-09-06: there are no nav-worthy routes any more.** The site is a
// single page whose header carries a brand link and one sign-in control, so
// `routes.ts` dropped the `navLabelKey` field this suite used to filter on
// and the old `navRoutes.length > 0` assertion could no longer hold.
//
// Rewritten rather than deleted, and slightly stronger than before: every
// registered route is walked, not just the subset that used to appear in a
// header. Those routes are still real destinations — the blog and workshop
// archives the landing page links out to, testimonials, contact, and the
// five legal documents in the footer — and a 404 on any of them is a broken
// link somewhere, whether or not a nav bar points at it.
describe('ephemeral PR environment — routes + footer', () => {
  it('registers at least one route', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  for (const route of routes) {
    it(`route ${route.path} resolves 200`, async () => {
      const response = await fetch(`${getBaseUrl()}${route.path}`);
      expect(response.status).toBe(200);
    });
  }

  // The landing page's two "older posts" buttons. They are same-origin
  // paths, not the absolute `nourishthenerve.com` URLs the owner named, so
  // that they keep working on `next.`, on staging and here — which is
  // precisely the thing worth proving in an ephemeral environment.
  for (const archive of ['blog', 'workshops']) {
    it(`the landing page links to /${defaultLocale}/${archive} without leaving this origin`, async () => {
      const response = await fetch(`${getBaseUrl()}/${defaultLocale}`);
      const html = await response.text();

      expect(html).toContain(`href="/${defaultLocale}/${archive}"`);
      expect(html).not.toContain(`https://nourishthenerve.com/${defaultLocale}/${archive}`);
    });
  }

  it('footer renders every configured social link', async () => {
    const response = await fetch(`${getBaseUrl()}/${defaultLocale}`);
    const html = await response.text();

    for (const link of socialLinks) {
      expect(html).toContain(link.href);
    }
  });

  it('footer renders every legal page link', async () => {
    const response = await fetch(`${getBaseUrl()}/${defaultLocale}`);
    const html = await response.text();

    for (const page of legalPages) {
      expect(html).toContain(`/${defaultLocale}/legal/${page.slug}`);
    }
  });
});
