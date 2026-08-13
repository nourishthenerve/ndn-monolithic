import { defaultLocale } from '@ndn/i18n';
import { routes } from '@ndn/web/routes.js';
import { socialLinks } from '@ndn/web/social-links.js';
import { describe, expect, it } from 'vitest';

import { getBaseUrl } from './env.js';

// TASK 1.2.1: nav links to every route routes.ts marks as nav-worthy
// (`navLabelKey` set) — this proves each one is actually reachable (200),
// not just present in markup. Footer's social links are external and come
// from social-links.ts rather than routes.ts, so this suite instead
// proves the footer really rendered every configured href.
describe('ephemeral PR environment — nav + footer', () => {
  const navRoutes = routes.filter((route) => route.navLabelKey !== undefined);

  it('at least one route is nav-worthy', () => {
    expect(navRoutes.length).toBeGreaterThan(0);
  });

  for (const route of navRoutes) {
    it(`nav route ${route.path} resolves 200`, async () => {
      const response = await fetch(`${getBaseUrl()}${route.path}`);
      expect(response.status).toBe(200);
    });
  }

  it('footer renders every configured social link', async () => {
    const response = await fetch(`${getBaseUrl()}/${defaultLocale}`);
    const html = await response.text();

    for (const link of socialLinks) {
      expect(html).toContain(link.href);
    }
  });
});
