// TASK 1.1.1: colour pairs pre-checked for WCAG 2.2 contrast — ≥4.5:1 for
// body text, ≥3:1 for large text/non-text UI (§1.4.3, §1.4.11). Every
// contrastOnLight/contrastOnDark value below is computed from the actual
// hex pair at module-load time, not hand-typed, so a hex edit that
// regresses contrast is caught by color.test.ts rather than trusted.
//
// ## 2026-09-07: the olive-and-lavender palette
//
// The owner asked for a theme drawn from the brand mark
// (`apps/web/public/logo-mark.png` — a brain that is also a leaf, held in a
// hand), with Two Chairs and C Witt Counseling as the reference for how it
// should feel: quiet, warm, a lot of air, nothing shouting. So the hues here
// are the mark's own — a deep olive green for anything that acts, a muted
// lavender for anything that accents — over a warm paper ground rather than
// flat white.
//
// ## Three kinds of token, and why they are separated
//
// Until now every token in this file was a *foreground*, and each was checked
// against one hard-coded page colour (`#ffffff` on light). A themed site does
// not have one page colour: the landing page alone lays text over paper, over
// white cards, over an olive band and over a lavender band. Checking a
// foreground against white only would have certified a contrast ratio no
// visitor ever actually sees.
//
//   * `colorDefinitions` — foregrounds. Each is checked against **every**
//     surface below, and the ratio recorded is the **worst** of them, so
//     `contrastOnLight` now means "on the least forgiving light surface"
//     rather than "on white". Strictly stronger than what it replaced.
//   * `surfaceDefinitions` — the grounds text is allowed to sit on. Adding a
//     surface here re-checks every foreground against it automatically; a new
//     band that is too dark for muted text fails the suite instead of
//     shipping.
//   * `tintDefinitions` — decorative fills and lines. A status chip's fill
//     names the foreground it is worn with (`pairedWith`) and that pair is
//     checked at 4.5:1 too; a hairline names none, because a 1px card edge
//     carries no information a reader could lose.

import { contrastRatio } from './contrast.js';

export type ColorTokenName =
  | 'text'
  | 'textMuted'
  | 'brand'
  | 'brandStrong'
  | 'accent'
  | 'focusRing'
  | 'error'
  | 'warning';

export type SurfaceTokenName = 'surface' | 'surfaceRaised' | 'surfaceMuted' | 'surfaceAccent';

export type TintTokenName =
  | 'brandSoft'
  | 'brandWash'
  | 'accentSoft'
  | 'warningSoft'
  | 'errorSoft'
  | 'neutralSoft'
  | 'border'
  | 'borderStrong';

export interface ColorToken {
  /** CSS value consumers use — a custom-property reference, not a raw hex. */
  css: string;
  /** Ratio against the *worst* light surface, not against white. */
  contrastOnLight: number;
  contrastOnDark?: number;
}

interface ColorDefinition {
  readonly cssVar: string;
  readonly hexOnLight: string;
  readonly hexOnDark: string;
  /** WCAG category this token must clear — 4.5:1 body text, 3:1 large text/UI. */
  readonly category: 'text' | 'large-text-or-ui';
}

interface SurfaceDefinition {
  readonly cssVar: string;
  readonly hexOnLight: string;
  readonly hexOnDark: string;
}

interface TintDefinition {
  readonly cssVar: string;
  readonly hexOnLight: string;
  readonly hexOnDark: string;
  /**
   * The foreground token this fill is worn with, when it is a status chip or
   * another surface that carries words. `undefined` for a hairline or a hover
   * wash, which carry none.
   */
  readonly pairedWith?: ColorTokenName;
}

/**
 * Every ground body text is laid over. `surface` is the page itself — warm
 * paper rather than white, which is what stops a page of cards from reading
 * as a spreadsheet; `surfaceRaised` is what sits on top of it (cards, the
 * header, inputs); the other two are the alternating section bands, one olive
 * and one lavender.
 */
const surfaceDefinitions: Record<SurfaceTokenName, SurfaceDefinition> = {
  surface: {
    cssVar: '--ndn-color-surface',
    hexOnLight: '#f8f6f1',
    hexOnDark: '#141711',
  },
  surfaceRaised: {
    cssVar: '--ndn-color-surface-raised',
    hexOnLight: '#ffffff',
    hexOnDark: '#1c2018',
  },
  surfaceMuted: {
    cssVar: '--ndn-color-surface-muted',
    hexOnLight: '#edf0e6',
    hexOnDark: '#232922',
  },
  surfaceAccent: {
    cssVar: '--ndn-color-surface-accent',
    hexOnLight: '#f1ecf7',
    hexOnDark: '#232032',
  },
};

const colorDefinitions: Record<ColorTokenName, ColorDefinition> = {
  text: {
    cssVar: '--ndn-color-text',
    hexOnLight: '#232821',
    hexOnDark: '#eef1e9',
    category: 'text',
  },
  textMuted: {
    cssVar: '--ndn-color-text-muted',
    hexOnLight: '#56604d',
    hexOnDark: '#b4bdaa',
    category: 'text',
  },
  brand: {
    cssVar: '--ndn-color-brand',
    hexOnLight: '#4e6136',
    hexOnDark: '#a7c383',
    // 'text', not the 'large-text-or-ui' the old teal claimed: `.ndn-link`
    // paints body-size prose in this colour, so 3:1 was never the bar it
    // actually had to clear.
    category: 'text',
  },
  brandStrong: {
    cssVar: '--ndn-color-brand-strong',
    hexOnLight: '#3a4a26',
    hexOnDark: '#c6dda6',
    category: 'text',
  },
  accent: {
    cssVar: '--ndn-color-accent',
    hexOnLight: '#65558f',
    hexOnDark: '#c3b4e8',
    category: 'text',
  },
  focusRing: {
    cssVar: '--ndn-color-focus-ring',
    hexOnLight: '#3f3487',
    hexOnDark: '#a99cf0',
    category: 'large-text-or-ui',
  },
  error: {
    cssVar: '--ndn-color-error',
    hexOnLight: '#a62a20',
    hexOnDark: '#ff9d92',
    category: 'text',
  },
  warning: {
    cssVar: '--ndn-color-warning',
    hexOnLight: '#7a5209',
    hexOnDark: '#e8ba6b',
    category: 'text',
  },
};

const tintDefinitions: Record<TintTokenName, TintDefinition> = {
  brandSoft: {
    cssVar: '--ndn-color-brand-soft',
    hexOnLight: '#e3e9d7',
    hexOnDark: '#2b3720',
    pairedWith: 'brandStrong',
  },
  /** A hover/selected wash — a tint of the ground, not a chip. Carries no text of its own. */
  brandWash: {
    cssVar: '--ndn-color-brand-wash',
    hexOnLight: '#f2f5ea',
    hexOnDark: '#1e2419',
  },
  accentSoft: {
    cssVar: '--ndn-color-accent-soft',
    hexOnLight: '#e9e2f4',
    hexOnDark: '#2a2440',
    pairedWith: 'accent',
  },
  warningSoft: {
    cssVar: '--ndn-color-warning-soft',
    hexOnLight: '#f4e8cf',
    hexOnDark: '#3a2e15',
    pairedWith: 'warning',
  },
  errorSoft: {
    cssVar: '--ndn-color-error-soft',
    hexOnLight: '#f7e0dd',
    hexOnDark: '#3b1f1c',
    pairedWith: 'error',
  },
  neutralSoft: {
    cssVar: '--ndn-color-neutral-soft',
    hexOnLight: '#e8e9e3',
    hexOnDark: '#2a2d27',
    pairedWith: 'textMuted',
  },
  /** Hairlines: card edges, table rules, the header's underline. */
  border: {
    cssVar: '--ndn-color-border',
    hexOnLight: '#e5e3d9',
    hexOnDark: '#2c3128',
  },
  /** The heavier of the two — control outlines, a table's outer edge. */
  borderStrong: {
    cssVar: '--ndn-color-border-strong',
    hexOnLight: '#d0d2c3',
    hexOnDark: '#3c4237',
  },
};

const colorTokenNames = Object.keys(colorDefinitions) as ColorTokenName[];
const surfaceTokenNames = Object.keys(surfaceDefinitions) as SurfaceTokenName[];
const tintTokenNames = Object.keys(tintDefinitions) as TintTokenName[];

/** The worst contrast `hex` achieves against any surface in the given scheme — the ratio a reader is actually guaranteed. */
function worstContrastOnAnySurface(hex: string, scheme: 'light' | 'dark'): number {
  return Math.min(
    ...surfaceTokenNames.map((name) => {
      const surface = surfaceDefinitions[name];
      return contrastRatio(hex, scheme === 'light' ? surface.hexOnLight : surface.hexOnDark);
    }),
  );
}

export const colorTokens: Record<ColorTokenName, ColorToken> = Object.fromEntries(
  colorTokenNames.map((name) => {
    const def = colorDefinitions[name];
    const token: ColorToken = {
      css: `var(${def.cssVar})`,
      contrastOnLight: worstContrastOnAnySurface(def.hexOnLight, 'light'),
      contrastOnDark: worstContrastOnAnySurface(def.hexOnDark, 'dark'),
    };
    return [name, token];
  }),
) as Record<ColorTokenName, ColorToken>;

/** Surface tokens are backgrounds, so what they expose is a CSS reference and nothing else — the contrast they take part in is recorded on the foregrounds above. */
export const surfaceTokens: Record<SurfaceTokenName, { css: string }> = Object.fromEntries(
  surfaceTokenNames.map((name) => [name, { css: `var(${surfaceDefinitions[name].cssVar})` }]),
) as Record<SurfaceTokenName, { css: string }>;

export const tintTokens: Record<TintTokenName, { css: string }> = Object.fromEntries(
  tintTokenNames.map((name) => [name, { css: `var(${tintDefinitions[name].cssVar})` }]),
) as Record<TintTokenName, { css: string }>;

/** Minimum WCAG contrast ratio each token must clear, per its category. */
export const colorTokenMinimumContrast: Record<ColorTokenName, number> = Object.fromEntries(
  colorTokenNames.map((name) => [name, colorDefinitions[name].category === 'text' ? 4.5 : 3]),
) as Record<ColorTokenName, number>;

/** Every tint that carries words, and the foreground token worn on it — what `color.test.ts` walks to check status chips. */
export const tintForegroundPairs: readonly {
  tint: TintTokenName;
  foreground: ColorTokenName;
}[] = tintTokenNames.flatMap((tint) => {
  const pairedWith = tintDefinitions[tint].pairedWith;
  return pairedWith === undefined ? [] : [{ tint, foreground: pairedWith }];
});

/** Contrast of a chip's foreground against that chip's own fill, in the given scheme. */
export function tintPairContrast(
  tint: TintTokenName,
  foreground: ColorTokenName,
  scheme: 'light' | 'dark',
): number {
  const fill = tintDefinitions[tint];
  const ink = colorDefinitions[foreground];
  return scheme === 'light'
    ? contrastRatio(ink.hexOnLight, fill.hexOnLight)
    : contrastRatio(ink.hexOnDark, fill.hexOnDark);
}

/**
 * Contrast of the label a solid fill carries — `.ndn-button--primary` and the
 * calendar's filled chips paint `--ndn-color-surface-raised` over a solid
 * brand/accent/error, so that pairing needs checking as much as the reverse.
 */
export function solidFillLabelContrast(fill: ColorTokenName, scheme: 'light' | 'dark'): number {
  const def = colorDefinitions[fill];
  const label = surfaceDefinitions.surfaceRaised;
  return scheme === 'light'
    ? contrastRatio(label.hexOnLight, def.hexOnLight)
    : contrastRatio(surfaceDefinitions.surface.hexOnDark, def.hexOnDark);
}

/** Shared pass/fail check color.test.ts uses for every real token — and for the deliberately-regressed fixture that proves the check can fail. */
export function meetsMinimumContrast(ratio: number, minimum: number): boolean {
  return ratio >= minimum;
}

/** Raw hex values for the given scheme, keyed by the CSS custom property name — consumed once, by the global stylesheet that defines `:root`. */
export function colorSchemeCssVariables(scheme: 'light' | 'dark'): Record<string, string> {
  const pick = (def: { hexOnLight: string; hexOnDark: string }) =>
    scheme === 'light' ? def.hexOnLight : def.hexOnDark;
  return {
    ...Object.fromEntries(
      surfaceTokenNames.map((name) => [
        surfaceDefinitions[name].cssVar,
        pick(surfaceDefinitions[name]),
      ]),
    ),
    ...Object.fromEntries(
      colorTokenNames.map((name) => [colorDefinitions[name].cssVar, pick(colorDefinitions[name])]),
    ),
    ...Object.fromEntries(
      tintTokenNames.map((name) => [tintDefinitions[name].cssVar, pick(tintDefinitions[name])]),
    ),
  };
}
