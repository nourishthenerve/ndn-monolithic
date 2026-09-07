import { describe, expect, it } from 'vitest';

import {
  colorSchemeCssVariables,
  colorTokenMinimumContrast,
  colorTokens,
  meetsMinimumContrast,
  solidFillLabelContrast,
  surfaceTokens,
  tintForegroundPairs,
  tintPairContrast,
  tintTokens,
} from './color.js';
import { contrastRatio } from './contrast.js';

const tokenNames = Object.keys(colorTokens) as (keyof typeof colorTokens)[];

describe('colorTokens', () => {
  // 2026-09-07: "on light" now means "on the least forgiving light surface",
  // not "on white" — see color.ts's own header. A token that only cleared its
  // minimum on white would fail here, which is the point: the olive and
  // lavender section bands are grounds real body text sits on.
  it.each(tokenNames)('%s clears its minimum contrast on every light surface', (name) => {
    const token = colorTokens[name];
    const minimum = colorTokenMinimumContrast[name];
    expect(meetsMinimumContrast(token.contrastOnLight, minimum)).toBe(true);
  });

  it.each(tokenNames)('%s clears its minimum contrast on every dark surface', (name) => {
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
    for (const token of [...Object.values(surfaceTokens), ...Object.values(tintTokens)]) {
      expect(token.css).toMatch(/^var\(--ndn-color-[a-z-]+\)$/);
    }
  });
});

describe('tinted fills that carry words', () => {
  it('there is at least one such pair to check', () => {
    expect(tintForegroundPairs.length).toBeGreaterThan(0);
  });

  // A status chip is a foreground on a fill of its own hue, so neither its
  // contrast against the page nor the page's against the fill says anything
  // useful — only the pair does.
  it.each(tintForegroundPairs)(
    '$foreground on $tint clears 4.5:1 in both schemes',
    ({ tint, foreground }) => {
      expect(meetsMinimumContrast(tintPairContrast(tint, foreground, 'light'), 4.5)).toBe(true);
      expect(meetsMinimumContrast(tintPairContrast(tint, foreground, 'dark'), 4.5)).toBe(true);
    },
  );
});

describe('solid fills', () => {
  // `.ndn-button--primary` and the calendar's filled chips reverse the usual
  // arrangement: the raised-surface colour becomes the ink and the token
  // becomes the ground.
  it.each(['brand', 'accent', 'error'] as const)(
    'a label on solid %s clears 4.5:1 in both schemes',
    (fill) => {
      expect(meetsMinimumContrast(solidFillLabelContrast(fill, 'light'), 4.5)).toBe(true);
      expect(meetsMinimumContrast(solidFillLabelContrast(fill, 'dark'), 4.5)).toBe(true);
    },
  );
});

describe('colorSchemeCssVariables', () => {
  const expectedCount =
    tokenNames.length + Object.keys(surfaceTokens).length + Object.keys(tintTokens).length;

  it('emits one hex value per token — foregrounds, surfaces and tints alike', () => {
    const light = colorSchemeCssVariables('light');
    expect(Object.keys(light)).toHaveLength(expectedCount);
    for (const value of Object.values(light)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('defines every custom property the tokens advertise', () => {
    const light = colorSchemeCssVariables('light');
    for (const token of [
      ...Object.values(colorTokens),
      ...Object.values(surfaceTokens),
      ...Object.values(tintTokens),
    ]) {
      const property = token.css.slice('var('.length, -1);
      expect(light[property]).toBeDefined();
    }
  });

  it('the dark scheme emits different hex values than light for the same properties', () => {
    const light = colorSchemeCssVariables('light');
    const dark = colorSchemeCssVariables('dark');
    expect(Object.keys(dark).sort()).toEqual(Object.keys(light).sort());
    expect(dark['--ndn-color-text']).not.toBe(light['--ndn-color-text']);
    expect(dark['--ndn-color-surface']).not.toBe(light['--ndn-color-surface']);
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

  it('a foreground that only clears its minimum on white is rejected by the every-surface rule', () => {
    // Chosen to sit *above* 4.5:1 on white and *below* it on the darkest
    // light surface — exactly the regression a white-only check cannot see,
    // and the reason contrastOnLight is now a minimum across all surfaces.
    const onWhite = contrastRatio('#6d7a63', '#ffffff');
    const onOliveBand = contrastRatio('#6d7a63', '#edf0e6');
    expect(meetsMinimumContrast(onWhite, 4.5)).toBe(true);
    expect(meetsMinimumContrast(onOliveBand, 4.5)).toBe(false);
  });
});
