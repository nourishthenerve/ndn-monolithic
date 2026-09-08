// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { getCssRuleBody } from '../test-support/css-rule.js';
import { injectPrimitiveStyles } from '../test-support/inject-styles.js';

import { primitiveStylesCss } from './primitive-styles.js';
import { Spinner } from './Spinner.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('Spinner', () => {
  // The point of the component, not an implementation detail: the sentence
  // beside a spinner is what announces the wait, so a spinner that announced
  // one too would say it twice. See Loading.tsx.
  it('is decorative — hidden from assistive tech and carrying no role or name', () => {
    const { container } = render(<Spinner />);
    const el = container.querySelector('.ndn-spinner');
    expect(el).not.toBeNull();
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el).not.toHaveAttribute('role');
    expect(el?.textContent).toBe('');
  });

  it('defaults to the medium size and accepts the other two', () => {
    const { container, rerender } = render(<Spinner />);
    expect(container.querySelector('.ndn-spinner')).toHaveClass('ndn-spinner--md');

    rerender(<Spinner size="sm" />);
    expect(container.querySelector('.ndn-spinner')).toHaveClass('ndn-spinner--sm');

    rerender(<Spinner size="lg" />);
    expect(container.querySelector('.ndn-spinner')).toHaveClass('ndn-spinner--lg');
  });

  it('keeps a caller className alongside its own', () => {
    const { container } = render(<Spinner className="extra" />);
    const el = container.querySelector('.ndn-spinner');
    expect(el).toHaveClass('extra');
    expect(el).toHaveClass('ndn-spinner');
  });

  it('animates through a named keyframe rather than an inline duration a reduced-motion reader cannot escape', () => {
    const body = getCssRuleBody(primitiveStylesCss, '.ndn-spinner');
    expect(body).toContain('animation: ndn-spin');
    expect(primitiveStylesCss).toContain('@keyframes ndn-spin');
  });
});
