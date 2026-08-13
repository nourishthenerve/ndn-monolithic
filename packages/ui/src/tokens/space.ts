// TASK 1.1.1: spacing scale + the WCAG 2.2 SC 2.5.8 target-size floor every
// interactive primitive is built against.

export const spaceTokens = {
  none: '0',
  xs: '0.25rem',
  sm: '0.5rem',
  md: '1rem',
  lg: '1.5rem',
  xl: '2rem',
  xxl: '3rem',
} as const;

export type SpaceTokenName = keyof typeof spaceTokens;

/**
 * WCAG 2.2 SC 2.5.8 (Target Size Minimum): every interactive control's
 * rendered box must be at least this in both dimensions, in CSS pixels —
 * deliberately a `px` floor, not `rem`, so it can't shrink if a consumer's
 * root font-size ever does.
 */
export const minInteractiveTargetPx = 24;
