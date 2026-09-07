import { describe, expect, it } from 'vitest';

import { getCssRuleBody } from '../test-support/css-rule.js';
import { colorSchemeCssVariables } from '../tokens/color.js';
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

  // 2026-09-07: the page ground is the warm paper surface, not the browser's
  // white. Cards, inputs and the header paint the raised surface on top of
  // it, and that one step of separation is what the card styling relies on
  // instead of a heavier border or a shadow.
  it('paints the page surface token on <body>', () => {
    expect(getCssRuleBody(primitiveStylesCss, 'body')).toContain(
      'background-color: var(--ndn-color-surface)',
    );
  });

  it('sets headings in the display family at the one weight it is self-hosted at', () => {
    const heading = getCssRuleBody(primitiveStylesCss, '.ndn-heading');
    expect(heading).toContain('font-family: var(--ndn-font-family-display)');
    expect(heading).toContain('font-weight: var(--ndn-font-weight-display)');
  });
});

describe('primitiveStylesCss — every colour comes from a token', () => {
  // The whole point of theming the primitives rather than the pages is that
  // the palette lives in exactly one file. A literal colour here would be a
  // value `tokens/color.ts` cannot change and `color.test.ts` never checks
  // for contrast — so it is a failure, not a style preference.
  it('contains no literal hex, rgb() or hsl() colour', () => {
    const literals = primitiveStylesCss.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g);
    expect(literals ?? []).toEqual([]);
  });

  it('names only custom properties that exist in the emitted scheme', () => {
    const declared = new Set(Object.keys(colorSchemeCssVariables('light')));
    const referenced = primitiveStylesCss.match(/var\(--ndn-color-[a-z-]+\)/g) ?? [];
    expect(referenced.length).toBeGreaterThan(0);
    for (const reference of new Set(referenced)) {
      expect(declared).toContain(reference.slice('var('.length, -1));
    }
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
