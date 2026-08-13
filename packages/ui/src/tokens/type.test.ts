import { describe, expect, it } from 'vitest';

import {
  fontFamilyCssVar,
  largeTextBoldMinPx,
  largeTextMinPx,
  typeTokenCssVariables,
  typeTokens,
} from './type.js';

describe('typeTokens', () => {
  it('every font size is a valid rem length', () => {
    for (const value of Object.values(typeTokens.fontSize)) {
      expect(value).toMatch(/^[\d.]+rem$/);
    }
  });

  it('line heights ascend from tight to relaxed', () => {
    expect(typeTokens.lineHeight.tight).toBeLessThan(typeTokens.lineHeight.base);
    expect(typeTokens.lineHeight.base).toBeLessThan(typeTokens.lineHeight.relaxed);
  });
});

describe('large-text thresholds', () => {
  it('the bold threshold is smaller than the regular-weight threshold', () => {
    expect(largeTextBoldMinPx).toBeLessThan(largeTextMinPx);
  });
});

describe('typeTokenCssVariables', () => {
  it('emits the font-family custom property primitive-styles.ts references', () => {
    const variables = typeTokenCssVariables();
    expect(variables[fontFamilyCssVar]).toBe(typeTokens.fontFamily.base);
  });
});
