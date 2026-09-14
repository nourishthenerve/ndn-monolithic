// 2026-09-07: the one rule behind every "Published …" line on the site.
//
// Small enough to look untestable, and it is the fallback that makes it
// worth pinning: every post and workshop live today predates `publishedAt`,
// so the `created_at` branch is not a defensive edge case — it is what the
// site actually renders right now.
import { describe, expect, it } from 'vitest';

import { isRecentlyPublished, NEW_WINDOW_DAYS, publicationDateOf } from './publication-date.js';

describe('publicationDateOf', () => {
  it('prefers the date the record was actually published', () => {
    expect(
      publicationDateOf({
        publishedAt: '2026-09-03T09:00:00.000Z',
        created_at: '2026-08-01T09:00:00.000Z',
      }),
    ).toBe('2026-09-03T09:00:00.000Z');
  });

  it('falls back to created_at for a record written before publishedAt existed', () => {
    expect(publicationDateOf({ created_at: '2026-08-01T09:00:00.000Z' })).toBe(
      '2026-08-01T09:00:00.000Z',
    );
  });

  it('is undefined when the record carries neither, so a card renders no date rather than breaking', () => {
    expect(publicationDateOf({})).toBeUndefined();
  });
});

describe('isRecentlyPublished', () => {
  // A fixed "now" so the boundary cases below are exact, not clock-dependent.
  const now = Date.parse('2026-09-14T00:00:00.000Z');

  it('is true just inside the 30-day window', () => {
    // 29 days ago.
    expect(isRecentlyPublished('2026-08-16T00:00:00.000Z', now)).toBe(true);
  });

  it('is true for something published moments ago', () => {
    expect(isRecentlyPublished('2026-09-13T23:00:00.000Z', now)).toBe(true);
  });

  it('is false once it is 30 days old or more — the window is "less than 30 days"', () => {
    // Exactly 30 days ago: at the edge, and past "less than".
    expect(isRecentlyPublished('2026-08-15T00:00:00.000Z', now)).toBe(false);
    // 45 days ago.
    expect(isRecentlyPublished('2026-07-31T00:00:00.000Z', now)).toBe(false);
  });

  it('is false for a date in the future — not new, wrong', () => {
    expect(isRecentlyPublished('2026-09-20T00:00:00.000Z', now)).toBe(false);
  });

  it('is false for a missing or unparseable date', () => {
    expect(isRecentlyPublished(undefined, now)).toBe(false);
    expect(isRecentlyPublished('not a date', now)).toBe(false);
  });

  it('honours a custom window', () => {
    expect(isRecentlyPublished('2026-09-10T00:00:00.000Z', now, 3)).toBe(false);
    expect(isRecentlyPublished('2026-09-12T00:00:00.000Z', now, 3)).toBe(true);
  });

  it('defaults to a 30-day window', () => {
    expect(NEW_WINDOW_DAYS).toBe(30);
  });
});
