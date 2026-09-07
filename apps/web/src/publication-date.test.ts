// 2026-09-07: the one rule behind every "Published …" line on the site.
//
// Small enough to look untestable, and it is the fallback that makes it
// worth pinning: every post and workshop live today predates `publishedAt`,
// so the `created_at` branch is not a defensive edge case — it is what the
// site actually renders right now.
import { describe, expect, it } from 'vitest';

import { publicationDateOf } from './publication-date.js';

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
