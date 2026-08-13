import { describe, expect, it } from 'vitest';

import {
  colorSchemeCssVariables,
  colorTokenMinimumContrast,
  colorTokens,
  meetsMinimumContrast,
} from './color.js';
import { contrastRatio } from './contrast.js';

const tokenNames = Object.keys(colorTokens) as (keyof typeof colorTokens)[];

describe('colorTokens', () => {
  it.each(tokenNames)('%s clears its minimum contrast on light', (name) => {
    const token = colorTokens[name];
    const minimum = colorTokenMinimumContrast[name];
    expect(meetsMinimumContrast(token.contrastOnLight, minimum)).toBe(true);
  });

  it.each(tokenNames)('%s clears its minimum contrast on dark', (name) => {
    const token = colorTokens[name];
    const minimum = colorTokenMinimumContrast[name];
    const ratio = token.contrastOnDark;
    expect(ratio).toBeDefined();
    expect(meetsMinimumContrast(ratio as number, minimum)).toBe(true);
  });

  it('exposes a CSS custom-property reference, never a raw hex, as the consumable value', () => {
    for (const name of tokenNames) {
      expect(colorTokens[name].css).toMatch(/^var\(--ndn-color-[a-z-]+\)$/);
    }
  });
});

describe('colorSchemeCssVariables', () => {
  it('emits one hex value per token, keyed by its CSS custom-property name', () => {
    const light = colorSchemeCssVariables('light');
    expect(Object.keys(light)).toHaveLength(tokenNames.length);
    expect(light['--ndn-color-text']).toBe('#14181f');
  });

  it('the dark scheme emits different hex values than light for the same properties', () => {
    const light = colorSchemeCssVariables('light');
    const dark = colorSchemeCssVariables('dark');
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    expect(dark['--ndn-color-text']).not.toBe(light['--ndn-color-text']);
  });
});

describe('the contrast guard itself', () => {
  it('fails a token deliberately regressed to ~3.9:1 against the 4.5:1 body-text minimum', () => {
    // #818181 on white is ~3.9:1 — picked to sit just under the body-text
    // floor, proving the same check real tokens go through actually
    // rejects a bad value rather than only ever seeing values that pass.
    const regressedRatio = contrastRatio('#818181', '#ffffff');
    expect(regressedRatio).toBeGreaterThan(3.8);
    expect(regressedRatio).toBeLessThan(4.0);
    expect(meetsMinimumContrast(regressedRatio, 4.5)).toBe(false);
  });

  it('the same regressed ratio would pass the looser 3:1 large-text/UI minimum', () => {
    const regressedRatio = contrastRatio('#818181', '#ffffff');
    expect(meetsMinimumContrast(regressedRatio, 3)).toBe(true);
  });
});
