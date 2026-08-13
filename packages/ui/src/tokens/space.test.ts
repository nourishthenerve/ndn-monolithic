import { describe, expect, it } from 'vitest';

import { minInteractiveTargetPx, spaceTokens } from './space.js';

describe('spaceTokens', () => {
  it('every value is a valid CSS length', () => {
    for (const value of Object.values(spaceTokens)) {
      expect(value).toMatch(/^(0|[\d.]+rem)$/);
    }
  });
});

describe('minInteractiveTargetPx', () => {
  it('matches WCAG 2.2 SC 2.5.8', () => {
    expect(minInteractiveTargetPx).toBe(24);
  });
});
