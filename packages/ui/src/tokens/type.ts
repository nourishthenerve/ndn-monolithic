// TASK 1.1.1: typography scale. `largeTextMinPx`/`largeTextBoldMinPx`
// record WCAG's own "large text" thresholds (§1.4.3) — text at or above
// these sizes is checked against color.ts's 3:1 category, not 4.5:1.
//
// 2026-09-07: a second family. Every heading on the site is now set in
// Cormorant Garamond — a high-contrast old-style serif — while Inter keeps
// everything a reader has to work through: prose, labels, controls, tables.
// That split is the whole of the "elegant" the owner asked for, and it is the
// arrangement both reference sites use; a serif large enough to be a voice
// and a sans small enough to disappear. Only the 600 weight is self-hosted
// (see apps/web/src/styles/fonts.css), so `fontWeight.display` is 600 and not
// `bold` — asking the browser for 700 of a family it only has at 600 gets a
// synthesised, smeared bold.

export const typeTokens = {
  fontFamily: {
    base: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
    // The fallbacks are the serifs most likely to already be installed and
    // closest in colour to Cormorant, so a page mid-font-swap does not
    // visibly change shape.
    display: "'Cormorant Garamond', 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, serif",
  },
  fontSize: {
    sm: '0.875rem',
    base: '1rem',
    lg: '1.25rem',
    xl: '1.5rem',
    xxl: '2rem',
  },
  lineHeight: {
    tight: 1.2,
    base: 1.5,
    relaxed: 1.7,
  },
  fontWeight: {
    regular: 400,
    medium: 500,
    /** The one weight of the display family that is self-hosted. */
    display: 600,
    bold: 700,
  },
} as const;

export type FontSizeToken = keyof typeof typeTokens.fontSize;

/** WCAG "large text": ≥18pt, i.e. ≥24 CSS px at a 96dpi/16px-root baseline. */
export const largeTextMinPx = 24;
/** WCAG "large text" for bold weight: ≥14pt, i.e. ≥18.66 CSS px. */
export const largeTextBoldMinPx = 18.66;

export const fontFamilyCssVar = '--ndn-font-family-base';
export const displayFontFamilyCssVar = '--ndn-font-family-display';
export const displayFontWeightCssVar = '--ndn-font-weight-display';

/** `:root` custom properties for the properties primitive-styles.ts's components reference (e.g. `var(${fontFamilyCssVar})` in `.ndn-button`). */
export function typeTokenCssVariables(): Record<string, string> {
  return {
    [fontFamilyCssVar]: typeTokens.fontFamily.base,
    [displayFontFamilyCssVar]: typeTokens.fontFamily.display,
    [displayFontWeightCssVar]: String(typeTokens.fontWeight.display),
  };
}
