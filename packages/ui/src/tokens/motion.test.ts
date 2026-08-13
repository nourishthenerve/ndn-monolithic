import { describe, expect, it } from 'vitest';

import { motionDurationCssVar, motionTokens, reducedMotionGlobalCss } from './motion.js';

describe('reducedMotionGlobalCss', () => {
  it('collapses every duration custom property under prefers-reduced-motion: reduce', () => {
    expect(reducedMotionGlobalCss).toContain('@media (prefers-reduced-motion: reduce)');
    const reducedBlock = reducedMotionGlobalCss.split('@media (prefers-reduced-motion: reduce)')[1];
    expect(reducedBlock).toBeDefined();
    for (const cssVar of Object.values(motionDurationCssVar)) {
      expect(reducedBlock).toContain(`${cssVar}: 0.01ms`);
    }
  });

  it('forces animation and transition durations to near-zero as a blanket fallback', () => {
    const reducedBlock =
      reducedMotionGlobalCss.split('@media (prefers-reduced-motion: reduce)')[1] ?? '';
    expect(reducedBlock).toContain('animation-duration: 0.01ms !important');
    expect(reducedBlock).toContain('transition-duration: 0.01ms !important');
  });

  it('defines the normal-motion durations from motionTokens, not a second literal set', () => {
    expect(reducedMotionGlobalCss).toContain(motionTokens.duration.fast);
    expect(reducedMotionGlobalCss).toContain(motionTokens.duration.base);
    expect(reducedMotionGlobalCss).toContain(motionTokens.duration.slow);
  });
});
