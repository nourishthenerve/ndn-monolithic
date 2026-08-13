// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { getCssRuleBody } from '../test-support/css-rule.js';
import { injectPrimitiveStyles } from '../test-support/inject-styles.js';
import { minInteractiveTargetPx } from '../tokens/space.js';

import { Input } from './Input.js';
import { interactiveClassName, primitiveStylesCss } from './primitive-styles.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('Input', () => {
  it('is always associated with a visible <label> — no placeholder-only variant', () => {
    const { getByLabelText } = render(<Input label="Email address" />);
    expect(getByLabelText('Email address').tagName).toBe('INPUT');
  });

  it(`meets the ${minInteractiveTargetPx}px WCAG 2.5.8 tap target`, () => {
    const { getByLabelText } = render(<Input label="Email address" />);
    const computed = getComputedStyle(getByLabelText('Email address'));
    expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
    expect(Number.parseFloat(computed.minWidth)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
  });

  it('wires the shared interactive class, which carries a non-empty :focus-visible rule', () => {
    const { getByLabelText } = render(<Input label="Email address" />);
    expect(getByLabelText('Email address')).toHaveClass(interactiveClassName);
    const body = getCssRuleBody(primitiveStylesCss, `.${interactiveClassName}:focus-visible`);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('has no error state by default: no aria-invalid, no aria-describedby, no error text', () => {
    const { getByLabelText, queryByRole } = render(<Input label="Email address" />);
    const el = getByLabelText('Email address');
    expect(el).not.toHaveAttribute('aria-invalid');
    expect(el).not.toHaveAttribute('aria-describedby');
    expect(queryByRole('alert')).toBeNull();
  });

  it('an error message is announced (role=alert) and cross-referenced via aria-describedby', () => {
    const { getByLabelText, getByRole } = render(
      <Input label="Email address" error="Enter a valid email" />,
    );
    const el = getByLabelText('Email address');
    const alert = getByRole('alert');
    expect(alert).toHaveTextContent('Enter a valid email');
    expect(el).toHaveAttribute('aria-invalid', 'true');
    expect(el.getAttribute('aria-describedby')).toBe(alert.id);
  });
});
