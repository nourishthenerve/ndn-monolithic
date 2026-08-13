// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { getCssRuleBody } from '../test-support/css-rule.js';
import { injectPrimitiveStyles } from '../test-support/inject-styles.js';
import { minInteractiveTargetPx } from '../tokens/space.js';

import { interactiveClassName, primitiveStylesCss } from './primitive-styles.js';
import { SkipLink } from './SkipLink.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('SkipLink', () => {
  it('links to #main by default', () => {
    const { getByRole } = render(<SkipLink>Skip to main content</SkipLink>);
    expect(getByRole('link')).toHaveAttribute('href', '#main');
  });

  it('accepts a custom target id', () => {
    const { getByRole } = render(<SkipLink targetId="content">Skip to content</SkipLink>);
    expect(getByRole('link')).toHaveAttribute('href', '#content');
  });

  it(`meets the ${minInteractiveTargetPx}px WCAG 2.5.8 tap target`, () => {
    const { getByRole } = render(<SkipLink>Skip to main content</SkipLink>);
    const computed = getComputedStyle(getByRole('link'));
    expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
    expect(Number.parseFloat(computed.minWidth)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
  });

  it('wires the shared interactive class, and is moved on-screen by its own :focus rule', () => {
    const { getByRole } = render(<SkipLink>Skip to main content</SkipLink>);
    expect(getByRole('link')).toHaveClass(interactiveClassName);
    const focusVisibleBody = getCssRuleBody(
      primitiveStylesCss,
      `.${interactiveClassName}:focus-visible`,
    );
    expect(focusVisibleBody.trim().length).toBeGreaterThan(0);
    const skipLinkFocusBody = getCssRuleBody(primitiveStylesCss, '.ndn-skip-link:focus');
    expect(skipLinkFocusBody).toContain('top:');
  });

  it('is off-screen (negative top) until focused', () => {
    const offscreenBody = getCssRuleBody(primitiveStylesCss, '.ndn-skip-link');
    expect(offscreenBody).toMatch(/top:\s*-/);
  });
});
