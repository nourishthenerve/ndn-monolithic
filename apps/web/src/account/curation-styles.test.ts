import { describe, expect, it } from 'vitest';

import { curationStylesCss } from './curation-styles.js';

// The same reasoning `caseload-styles.test.ts` and `authoring-styles.test.ts`
// set out: a stylesheet held as a string can be read as text, and the
// coupling worth checking is between a class a component emits and a rule
// that styles it. The classes are string literals in `TestimonialCuration.tsx`,
// so a rename on either side compiles clean and simply stops working.

/** Every class this stylesheet exists to style, and where it is written (TestimonialCuration.tsx). */
const EMITTED_CLASSES = [
  'ndn-curation-list',
  'ndn-curation-item',
  'ndn-curation-order',
  'ndn-curation-order-name',
  'ndn-curation-order-actions',
];

describe('curationStylesCss', () => {
  it('styles every class the curation component emits', () => {
    for (const className of EMITTED_CLASSES) {
      expect(curationStylesCss, `no rule for .${className}`).toContain(`.${className}`);
    }
  });

  it('carries no raw colour — every value comes from tokens/color.ts', () => {
    expect(curationStylesCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(curationStylesCss).not.toMatch(/\brgba?\(/);
  });

  it('carries no backtick, which would end the template literal it lives in', () => {
    expect(curationStylesCss).not.toContain('`');
  });
});
