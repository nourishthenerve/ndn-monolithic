// TASK 1.1.1: typography scale. `largeTextMinPx`/`largeTextBoldMinPx`
// record WCAG's own "large text" thresholds (§1.4.3) — text at or above
// these sizes is checked against color.ts's 3:1 category, not 4.5:1.

export const typeTokens = {
  fontFamily: {
    base: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
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
    bold: 700,
  },
} as const;

export type FontSizeToken = keyof typeof typeTokens.fontSize;

/** WCAG "large text": ≥18pt, i.e. ≥24 CSS px at a 96dpi/16px-root baseline. */
export const largeTextMinPx = 24;
/** WCAG "large text" for bold weight: ≥14pt, i.e. ≥18.66 CSS px. */
export const largeTextBoldMinPx = 18.66;

export const fontFamilyCssVar = '--ndn-font-family-base';

/** `:root` custom properties for the properties primitive-styles.ts's components reference (e.g. `var(${fontFamilyCssVar})` in `.ndn-button`). */
export function typeTokenCssVariables(): Record<string, string> {
  return { [fontFamilyCssVar]: typeTokens.fontFamily.base };
}
