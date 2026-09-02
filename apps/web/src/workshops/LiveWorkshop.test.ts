// 2026-09-02: the one piece of the fallback workshop page worth pinning on
// its own — the date format. It must match what `[slug].astro` renders at
// build time, or the same workshop shows its time two different ways
// depending on whether the site has been rebuilt since it was published.
import { describe, expect, it } from 'vitest';

import { formatWorkshopDate } from './LiveWorkshop.js';

describe('formatWorkshopDate', () => {
  it('matches the build-time page: long date, short time', () => {
    // The identical `Intl.DateTimeFormat` options `[slug].astro` uses.
    const expected = new Intl.DateTimeFormat('en', {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(new Date('2026-10-01T10:00:00.000Z'));

    expect(formatWorkshopDate('2026-10-01T10:00:00.000Z', 'en')).toBe(expected);
  });

  it('renders in the reader\'s own locale, from a stored UTC instant', () => {
    // The stored value is always UTC (00-conventions.md); the rendering is
    // the reader's, which is why this is not a fixed string.
    expect(formatWorkshopDate('2026-10-01T10:00:00.000Z', 'en')).toContain('2026');
  });
});
