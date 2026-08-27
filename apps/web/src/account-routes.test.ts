import { describe, expect, it } from 'vitest';

import { accountRoutes } from './account-routes.js';

describe('account-routes', () => {
  it('registers every known account-shell page for every supported locale', () => {
    expect(accountRoutes.length).toBeGreaterThanOrEqual(6);
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
