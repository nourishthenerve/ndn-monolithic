// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { getCssRuleBody } from '../test-support/css-rule.js';
import { injectPrimitiveStyles } from '../test-support/inject-styles.js';
import { minInteractiveTargetPx } from '../tokens/space.js';

import { Button } from './Button.js';
import { interactiveClassName, primitiveStylesCss } from './primitive-styles.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('Button', () => {
  it('renders a native <button>, defaulting to type="button" so it never submits a form by accident', () => {
    const { getByRole } = render(<Button>Save</Button>);
    const el = getByRole('button', { name: 'Save' });
    expect(el.tagName).toBe('BUTTON');
    expect(el).toHaveAttribute('type', 'button');
  });

  it('honours an explicit type', () => {
    const { getByRole } = render(<Button type="submit">Submit</Button>);
    expect(getByRole('button')).toHaveAttribute('type', 'submit');
  });

  it(`meets the ${minInteractiveTargetPx}px WCAG 2.5.8 tap target`, () => {
    const { getByRole } = render(<Button>Save</Button>);
    const computed = getComputedStyle(getByRole('button'));
    expect(Number.parseFloat(computed.minHeight)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
    expect(Number.parseFloat(computed.minWidth)).toBeGreaterThanOrEqual(minInteractiveTargetPx);
  });

  it('wires the shared interactive class, which carries a non-empty :focus-visible rule', () => {
    const { getByRole } = render(<Button>Save</Button>);
    expect(getByRole('button')).toHaveClass(interactiveClassName);
    const body = getCssRuleBody(primitiveStylesCss, `.${interactiveClassName}:focus-visible`);
    expect(body.trim().length).toBeGreaterThan(0);
  });

  it('defaults to the primary variant and supports secondary', () => {
    const { getByRole, rerender } = render(<Button>Save</Button>);
    expect(getByRole('button')).toHaveClass('ndn-button--primary');

    rerender(<Button variant="secondary">Save</Button>);
    expect(getByRole('button')).toHaveClass('ndn-button--secondary');
  });

  // 2026-09-08: the row-sized pill. `md` deliberately adds no class of its
  // own — `.ndn-button` already carries that size, so an `--md` class would
  // be a selector with an empty rule behind it.
  it('adds a size class only for the small variant, and keeps it past the tap-target floor', () => {
    const { getByRole, rerender } = render(<Button>Save</Button>);
    expect(getByRole('button').className).not.toContain('ndn-button--md');
    expect(getByRole('button')).not.toHaveClass('ndn-button--sm');

    rerender(<Button size="sm">Assign</Button>);
    const small = getByRole('button');
    expect(small).toHaveClass('ndn-button--sm');
    expect(small).toHaveClass(interactiveClassName);
    expect(Number.parseFloat(getComputedStyle(small).minHeight)).toBeGreaterThanOrEqual(
      minInteractiveTargetPx,
    );
  });

  it('forwards disabled state and extra className without dropping the built-in classes', () => {
    const { getByRole } = render(
      <Button disabled className="extra">
        Save
      </Button>,
    );
    const el = getByRole('button');
    expect(el).toBeDisabled();
    expect(el).toHaveClass('extra');
    expect(el).toHaveClass('ndn-button');
  });
});
