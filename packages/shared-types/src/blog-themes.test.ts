// 2026-09-13: the blog theme catalogue is a shared source of truth — the API
// validates against it and apps/web renders from it — so what is worth proving
// is that the list stays a set of stable ids and the guard agrees with it.
import { describe, expect, it } from 'vitest';

import { blogThemeIds, isBlogThemeId } from './blog-themes.js';

describe('blog themes', () => {
  it('lists the twelve themes with no duplicate ids', () => {
    expect(blogThemeIds).toHaveLength(12);
    expect(new Set(blogThemeIds).size).toBe(blogThemeIds.length);
  });

  it('uses only slug-shaped ids — lowercase words joined by single hyphens', () => {
    // The id is a catalogue-key leaf (`blog.theme.<id>`) and part of no URL,
    // but keeping it slug-shaped keeps it readable and free of the spaces or
    // dots that would make an awkward key.
    for (const id of blogThemeIds) {
      expect(id, id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('recognises every listed id and nothing else', () => {
    for (const id of blogThemeIds) {
      expect(isBlogThemeId(id), id).toBe(true);
    }
    expect(isBlogThemeId('not-a-theme')).toBe(false);
    expect(isBlogThemeId('')).toBe(false);
  });
});
