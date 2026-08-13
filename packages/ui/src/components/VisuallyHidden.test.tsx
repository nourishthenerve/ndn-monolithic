// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { injectPrimitiveStyles } from '../test-support/inject-styles.js';

import { VisuallyHidden } from './VisuallyHidden.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('VisuallyHidden', () => {
  it('renders its text content (present in the accessibility tree, just not on-screen)', () => {
    const { getByText } = render(<VisuallyHidden>Screen-reader-only text</VisuallyHidden>);
    expect(getByText('Screen-reader-only text').tagName).toBe('SPAN');
  });

  it('carries the visually-hidden class, clipped rather than display:none (stays announced to assistive tech)', () => {
    const { getByText } = render(<VisuallyHidden>Screen-reader-only text</VisuallyHidden>);
    const el = getByText('Screen-reader-only text');
    expect(el).toHaveClass('ndn-visually-hidden');
    const computed = getComputedStyle(el);
    expect(computed.display).not.toBe('none');
    expect(computed.width).toBe('1px');
    expect(computed.height).toBe('1px');
  });
});
