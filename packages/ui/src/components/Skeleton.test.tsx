// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { injectPrimitiveStyles } from '../test-support/inject-styles.js';

import { primitiveStylesCss } from './primitive-styles.js';
import { Skeleton } from './Skeleton.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('Skeleton', () => {
  it('is decorative — there is nothing here to read out', () => {
    const { container } = render(<Skeleton />);
    const el = container.querySelector('.ndn-skeleton');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el?.textContent).toBe('');
  });

  it('defaults to a line and accepts the other three shapes', () => {
    const { container, rerender } = render(<Skeleton />);
    expect(container.querySelector('.ndn-skeleton')).toHaveClass('ndn-skeleton--line');

    for (const shape of ['heading', 'block', 'pill'] as const) {
      rerender(<Skeleton shape={shape} />);
      expect(container.querySelector('.ndn-skeleton')).toHaveClass(`ndn-skeleton--${shape}`);
    }
  });

  it('takes an explicit width and height for the shapes the four presets do not cover', () => {
    const { container } = render(<Skeleton width="60%" height="4rem" />);
    const el = container.querySelector('.ndn-skeleton') as HTMLElement;
    expect(el.style.width).toBe('60%');
    expect(el.style.height).toBe('4rem');
  });

  // The sheen freezes at an arbitrary gradient position once the global
  // reduce block collapses the animation, so the stylesheet drops the
  // gradient by hand rather than leaving a half-swept shape on screen.
  it('drops its sheen under prefers-reduced-motion', () => {
    expect(primitiveStylesCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*[^}]*\.ndn-skeleton\s*\{\s*background-image: none;/,
    );
  });
});
