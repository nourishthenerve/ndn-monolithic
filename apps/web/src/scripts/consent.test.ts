// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { hasConsent, hasStoredConsent, setConsent } from './consent.js';

function clearConsentCookie(): void {
  document.cookie = 'ndn_consent=; path=/; max-age=0';
}

beforeEach(clearConsentCookie);

describe('hasConsent', () => {
  it('essential is always true, even with nothing recorded', () => {
    expect(hasConsent('essential')).toBe(true);
  });

  it('analytics is false until explicitly granted', () => {
    expect(hasConsent('analytics')).toBe(false);
    setConsent(['analytics']);
    expect(hasConsent('analytics')).toBe(true);
  });
});

describe('hasStoredConsent', () => {
  it('is false before any decision is recorded, true after — even a reject', () => {
    expect(hasStoredConsent()).toBe(false);
    setConsent([]);
    expect(hasStoredConsent()).toBe(true);
  });
});

describe('setConsent', () => {
  it('always includes essential even when every other category is rejected', () => {
    setConsent([]);
    expect(hasConsent('essential')).toBe(true);
    expect(hasConsent('analytics')).toBe(false);
  });

  it('de-duplicates a category passed alongside the implicit essential grant', () => {
    setConsent(['essential', 'analytics']);
    expect(document.cookie).toContain('essential%2Canalytics');
    expect(document.cookie).not.toContain('essential%2Cessential');
  });
});
