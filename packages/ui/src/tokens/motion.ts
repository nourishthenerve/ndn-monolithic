// TASK 1.1.1 (WCAG 2.2 SC 2.3.3): every animation/transition duration in
// this design system is driven by these CSS custom properties, never a
// literal duration, so the single `reducedMotionGlobalCss` block below can
// collapse them all to ~0 at once. `0.01ms` rather than `0` — some browsers
// skip firing `transitionend`/`animationend` for a genuinely zero-length
// run, which would silently break any component logic waiting on it.

export const motionTokens = {
  duration: {
    fast: '120ms',
    base: '200ms',
    slow: '320ms',
  },
  easing: {
    standard: 'cubic-bezier(0.2, 0, 0, 1)',
  },
} as const;

export const motionDurationCssVar = {
  fast: '--ndn-motion-duration-fast',
  base: '--ndn-motion-duration-base',
  slow: '--ndn-motion-duration-slow',
} as const;

const REDUCED_MOTION_DURATION = '0.01ms';

/**
 * Global stylesheet fragment: defines the duration custom properties at
 * their normal values, then — inside `prefers-reduced-motion: reduce` —
 * both collapses those custom properties AND forces every animation/
 * transition on the page to near-zero directly, so a component that
 * forgot to use the custom properties is still covered.
 */
export const reducedMotionGlobalCss = `:root {
  ${motionDurationCssVar.fast}: ${motionTokens.duration.fast};
  ${motionDurationCssVar.base}: ${motionTokens.duration.base};
  ${motionDurationCssVar.slow}: ${motionTokens.duration.slow};
}

@media (prefers-reduced-motion: reduce) {
  :root {
    ${motionDurationCssVar.fast}: ${REDUCED_MOTION_DURATION};
    ${motionDurationCssVar.base}: ${REDUCED_MOTION_DURATION};
    ${motionDurationCssVar.slow}: ${REDUCED_MOTION_DURATION};
  }

  *,
  *::before,
  *::after {
    animation-duration: ${REDUCED_MOTION_DURATION} !important;
    animation-iteration-count: 1 !important;
    transition-duration: ${REDUCED_MOTION_DURATION} !important;
    scroll-behavior: auto !important;
  }
}
`;
