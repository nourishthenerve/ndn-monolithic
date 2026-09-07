// 2026-09-02: the one piece of the fallback workshop page worth pinning on
// its own — the date format. It must match what `[slug].astro` renders at
// build time, or the same workshop shows its time two different ways
// depending on whether the site has been rebuilt since it was published.
//
// 2026-09-07: and now the listing card as well, which is what turned "two
// formatters kept in step by a comment" into one shared function. The
// expectation below is `@ndn/i18n`'s own `formatDateTime` for that reason —
// asserting the identity rather than re-deriving the options, so this test
// cannot pass while the two drift.
import { formatDateTime } from '@ndn/i18n';
import { describe, expect, it } from 'vitest';

import { formatWorkshopDate } from './LiveWorkshop.js';

describe('formatWorkshopDate', () => {
  it('renders a workshop time exactly as every other time on the site', () => {
    expect(formatWorkshopDate('2026-10-01T10:00:00.000Z', 'en')).toBe(
      formatDateTime('2026-10-01T10:00:00.000Z', 'en'),
    );
  });

  it('spells the month and names the zone', () => {
    // "October 1, 2026 at 11:00 AM GMT+1" — never a numeric 10/1 that means
    // two different days in two countries, and never a bare time that means
    // two different hours.
    const rendered = formatWorkshopDate('2026-10-01T10:00:00.000Z', 'en');

    expect(rendered).toContain('October');
    expect(rendered).toMatch(/(GMT|UTC)/);
  });

  it('renders in the reader\'s own locale, from a stored UTC instant', () => {
    // The stored value is always UTC (00-conventions.md); the rendering is
    // the reader's, which is why this is not a fixed string.
    expect(formatWorkshopDate('2026-10-01T10:00:00.000Z', 'en')).toContain('2026');
  });
});
