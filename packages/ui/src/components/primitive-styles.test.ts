import { describe, expect, it } from 'vitest';

import { getCssRuleBody } from '../test-support/css-rule.js';
import { minInteractiveTargetPx } from '../tokens/space.js';

import {
  interactiveClassName,
  primitiveStylesCss,
  visuallyHiddenClassName,
} from './primitive-styles.js';

describe('primitiveStylesCss — base typography', () => {
  it('sets the font-family and text color tokens on <body> (headings/paragraphs inherit rather than falling back to a browser-default serif)', () => {
    const body = getCssRuleBody(primitiveStylesCss, 'body');
    expect(body).toContain('font-family: var(--ndn-font-family-base)');
    expect(body).toContain('color: var(--ndn-color-text)');
  });
});

describe('primitiveStylesCss — tap target', () => {
  it(`the shared interactive class enforces the ${minInteractiveTargetPx}px WCAG 2.5.8 floor`, () => {
    const body = getCssRuleBody(primitiveStylesCss, `.${interactiveClassName}`);
    expect(body).toContain(`min-height: ${minInteractiveTargetPx}px`);
    expect(body).toContain(`min-width: ${minInteractiveTargetPx}px`);
  });
});

describe('primitiveStylesCss — focus-visible', () => {
  it('the shared interactive class has a non-empty :focus-visible rule that does not just remove the outline', () => {
    const body = getCssRuleBody(primitiveStylesCss, `.${interactiveClassName}:focus-visible`);
    expect(body.trim().length).toBeGreaterThan(0);
    expect(body).not.toMatch(/outline:\s*none\s*;?\s*$/);
    expect(body).toContain('outline');
  });

  it('the skip link has its own visible focus rule (shown on focus, not just outlined)', () => {
    const body = getCssRuleBody(primitiveStylesCss, '.ndn-skip-link:focus');
    expect(body.trim().length).toBeGreaterThan(0);
  });
});

describe('primitiveStylesCss — visually hidden utility', () => {
  it('clips content without display:none (stays announced to assistive tech)', () => {
    const body = getCssRuleBody(primitiveStylesCss, `.${visuallyHiddenClassName}`);
    expect(body).not.toContain('display: none');
    expect(body).toContain('clip: rect(0, 0, 0, 0)');
  });
});
