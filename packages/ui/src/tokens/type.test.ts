import { describe, expect, it } from 'vitest';

import {
  displayFontFamilyCssVar,
  displayFontWeightCssVar,
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

  it('emits the display family and its one self-hosted weight', () => {
    const variables = typeTokenCssVariables();
    expect(variables[displayFontFamilyCssVar]).toBe(typeTokens.fontFamily.display);
    expect(variables[displayFontWeightCssVar]).toBe(String(typeTokens.fontWeight.display));
  });

  // apps/web/src/styles/fonts.css self-hosts Cormorant Garamond at 600 only,
  // so a token asking for any other weight of it would be synthesised by the
  // browser rather than rendered.
  it('the display weight is one the display family is actually self-hosted at', () => {
    expect(typeTokens.fontWeight.display).toBe(600);
  });
});

describe('the two families', () => {
  it('are distinct, and each ends in a generic fallback', () => {
    expect(typeTokens.fontFamily.display).not.toBe(typeTokens.fontFamily.base);
    expect(typeTokens.fontFamily.base).toMatch(/sans-serif$/);
    expect(typeTokens.fontFamily.display).toMatch(/serif$/);
  });
});
