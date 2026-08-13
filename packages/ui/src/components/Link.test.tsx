// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { getCssRuleBody } from '../test-support/css-rule.js';
import { injectPrimitiveStyles } from '../test-support/inject-styles.js';
import { minInteractiveTargetPx } from '../tokens/space.js';

import { Link } from './Link.js';
import { interactiveClassName, primitiveStylesCss } from './primitive-styles.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('Link', () => {
  it('renders a native <a href>', () => {
    const { getByRole } = render(<Link href="/about">About</Link>);
    const el = getByRole('link', { name: 'About' });
    expect(el.tagName).toBe('A');
    expect(el).toHaveAttribute('href', '/about');
  });

  it(`meets the ${minInteractiveTargetPx}px WCAG 2.5.8 tap target`, () => {
    const { getByRole } = render(<Link href="/about">About</Link>);
    const computed = getComputedStyle(getByRole('link'));
    expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
    expect(Number.parseFloat(computed.minWidth)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
  });

  it('wires the shared interactive class, which carries a non-empty :focus-visible rule', () => {
    const { getByRole } = render(<Link href="/about">About</Link>);
    expect(getByRole('link')).toHaveClass(interactiveClassName);
    const body = getCssRuleBody(primitiveStylesCss, `.${interactiveClassName}:focus-visible`);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('does not open a new tab by default', () => {
    const { getByRole } = render(<Link href="/about">About</Link>);
    expect(getByRole('link')).not.toHaveAttribute('target');
  });

  it('external: adds target/rel and a screen-reader-only new-tab notice, never a silent new tab', () => {
    const { getByRole } = render(
      <Link href="https://example.com" external>
        Example
      </Link>,
    );
    const el = getByRole('link');
    expect(el).toHaveAttribute('target', '_blank');
    expect(el).toHaveAttribute('rel', 'noopener noreferrer');
    expect(el).toHaveTextContent('opens in a new tab');
  });
});
