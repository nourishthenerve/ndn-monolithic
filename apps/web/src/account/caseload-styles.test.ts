import { describe, expect, it } from 'vitest';

import { caseloadStylesCss } from './caseload-styles.js';

// The same reasoning `calendar-styles.test.ts` sets out: a stylesheet held
// as a string can be read as text, and the coupling worth checking is
// between a class the component emits and a rule that styles it.
//
// `PatientAccountStatus` lives in `CaseloadView.tsx` and this list mirrors
// it by hand — `apps/web` restates every API shape locally rather than
// depending on `@ndn/shared-types`, so nothing makes the compiler check this.
// It still catches a renamed or dropped badge rule, which would render a
// suspended patient in the same neutral grey as a declined one.
const STATUSES = ['approved', 'pending', 'declined', 'suspended'];

describe('caseloadStylesCss', () => {
  it('gives every account status its own badge rule', () => {
    for (const status of STATUSES) {
      expect(
        caseloadStylesCss,
        `no badge style for the "${status}" status`,
      ).toContain(`.ndn-caseload-status--${status}`);
    }
  });

  it('lets the table scroll inside its own container rather than the page', () => {
    // Six columns with a picker in one of them cannot fit a phone; the
    // alternative to this is the whole page scrolling sideways.
    expect(caseloadStylesCss).toContain('.ndn-caseload-scroll');
    expect(caseloadStylesCss).toContain('overflow-x: auto');
  });

  it('restates a focus outline for its own plain controls', () => {
    // They are not `packages/ui` primitives, so they inherit none of
    // `.ndn-interactive`'s focus styling.
    expect(caseloadStylesCss).toContain('.ndn-caseload-button:focus-visible');
    expect(caseloadStylesCss).toContain('.ndn-caseload-select:focus-visible');
  });

  it('marks an unassigned patient rather than leaving the cell to read as blank', () => {
    expect(caseloadStylesCss).toContain('.ndn-caseload-unassigned');
  });

  it('carries no backtick, which would end the template literal it lives in', () => {
    expect(caseloadStylesCss).not.toContain('`');
  });
});
