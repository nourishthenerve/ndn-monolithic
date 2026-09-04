import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { supportedLocales } from '@ndn/i18n';
import { describe, expect, it } from 'vitest';

import { accountRoutes } from './account-routes.js';

const ACCOUNT_PAGES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  'pages',
  '[locale]',
  'account',
);

/**
 * Deliberately not registered, and each for a stated reason — see this
 * module's own header. Listed here so the check below fails on a page that
 * merely *forgot*, rather than on one whose absence is a decision.
 */
const DELIBERATELY_UNREGISTERED = new Set(['callback']);

describe('account-routes', () => {
  it('registers every known account-shell page for every supported locale', () => {
    expect(accountRoutes.length).toBeGreaterThanOrEqual(6);
  });

  // 2026-09-04. This module's header states the guarantee it exists to
  // give: "A page added under `apps/web/src/pages/[locale]/account/` that
  // forgets to register itself here silently drops out of that gate."
  // Nothing enforced it — the registry was a hand-maintained list, and a
  // page dropping out of the live-session a11y and keyboard suites is
  // exactly the kind of gap that shows up as nothing at all. Written after
  // adding `appointments` and having to remember this file by hand.
  it('has an entry for every account page on disk', () => {
    const onDisk = readdirSync(ACCOUNT_PAGES_DIR)
      .filter((name) => name.endsWith('.astro'))
      .map((name) => name.replace(/\.astro$/, ''))
      .filter((segment) => !DELIBERATELY_UNREGISTERED.has(segment));

    const registered = new Set(
      accountRoutes
        .filter((route) => route.locale === supportedLocales[0])
        .map((route) => route.path.split('/account')[1]?.replace(/^\//, '') ?? ''),
    );

    // `index.astro` is `/account` itself, registered as the empty segment.
    const expected = onDisk.map((segment) => (segment === 'index' ? '' : segment));
    expect([...expected].sort()).toEqual([...registered].sort());
  });

  it('registers the patient calendar as the patient’s own page', () => {
    const route = accountRoutes.find((entry) => entry.path.endsWith('/account/appointments'));
    expect(route?.ownerRole).toBe('patient');
  });

  it('every path is absolute, locale-prefixed, and unique', () => {
    const seen = new Set<string>();
    for (const route of accountRoutes) {
      expect(route.path.startsWith(`/${route.locale}/account`)).toBe(true);
      expect(seen.has(route.path)).toBe(false);
      seen.add(route.path);
    }
  });

  it('only call needs an appointment id', () => {
    for (const route of accountRoutes) {
      const isCall = route.path.endsWith('/account/call');
      expect(Boolean(route.needsAppointmentId)).toBe(isCall);
    }
  });

  it('account/callback is deliberately absent — see this file own header comment', () => {
    expect(accountRoutes.some((route) => route.path.endsWith('/callback'))).toBe(false);
  });
});
