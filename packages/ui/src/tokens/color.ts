// TASK 1.1.1: colour pairs pre-checked for WCAG 2.2 contrast — ≥4.5:1 for
// body text, ≥3:1 for large text/non-text UI (§1.4.3, §1.4.11). Every
// contrastOnLight/contrastOnDark value below is computed from the actual
// hex pair at module-load time, not hand-typed, so a hex edit that
// regresses contrast is caught by color.test.ts rather than trusted.

import { contrastRatio } from './contrast.js';

/** Page background a token is checked against in each colour scheme. */
const SURFACE_LIGHT = '#ffffff';
const SURFACE_DARK = '#0b1220';

export type ColorTokenName = 'text' | 'textMuted' | 'brand' | 'focusRing' | 'error';

export interface ColorToken {
  /** CSS value consumers use — a custom-property reference, not a raw hex. */
  css: string;
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

const colorDefinitions: Record<ColorTokenName, ColorDefinition> = {
  text: {
    cssVar: '--ndn-color-text',
    hexOnLight: '#14181f',
    hexOnDark: '#f4f6f8',
    category: 'text',
  },
  textMuted: {
    cssVar: '--ndn-color-text-muted',
    hexOnLight: '#4b5563',
    hexOnDark: '#c2c9d1',
    category: 'text',
  },
  brand: {
    cssVar: '--ndn-color-brand',
    hexOnLight: '#0a6e5a',
    hexOnDark: '#4fd8b8',
    category: 'large-text-or-ui',
  },
  focusRing: {
    cssVar: '--ndn-color-focus-ring',
    hexOnLight: '#0a52d6',
    hexOnDark: '#7aa6ff',
    category: 'large-text-or-ui',
  },
  error: {
    cssVar: '--ndn-color-error',
    hexOnLight: '#b3261e',
    hexOnDark: '#ff8a80',
    category: 'text',
  },
};

const colorTokenNames = Object.keys(colorDefinitions) as ColorTokenName[];

export const colorTokens: Record<ColorTokenName, ColorToken> = Object.fromEntries(
  colorTokenNames.map((name) => {
    const def = colorDefinitions[name];
    const token: ColorToken = {
      css: `var(${def.cssVar})`,
      contrastOnLight: contrastRatio(def.hexOnLight, SURFACE_LIGHT),
      contrastOnDark: contrastRatio(def.hexOnDark, SURFACE_DARK),
    };
    return [name, token];
  }),
) as Record<ColorTokenName, ColorToken>;

/** Minimum WCAG contrast ratio each token must clear, per its category. */
export const colorTokenMinimumContrast: Record<ColorTokenName, number> = Object.fromEntries(
  colorTokenNames.map((name) => [name, colorDefinitions[name].category === 'text' ? 4.5 : 3]),
) as Record<ColorTokenName, number>;

/** Shared pass/fail check color.test.ts uses for every real token — and for the deliberately-regressed fixture that proves the check can fail. */
export function meetsMinimumContrast(ratio: number, minimum: number): boolean {
  return ratio >= minimum;
}

/** Raw hex values for the given scheme, keyed by the CSS custom property name — consumed once, by the global stylesheet that defines `:root`. */
export function colorSchemeCssVariables(scheme: 'light' | 'dark'): Record<string, string> {
  return Object.fromEntries(
    colorTokenNames.map((name) => {
      const def = colorDefinitions[name];
      return [def.cssVar, scheme === 'light' ? def.hexOnLight : def.hexOnDark];
    }),
  );
}
