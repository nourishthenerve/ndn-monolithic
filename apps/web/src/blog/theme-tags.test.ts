import { describe, expect, it } from 'vitest';

import { resolveBlogThemeTags } from './theme-tags.js';

const LABELS = {
  'pain-science': 'Pain Science',
  neurorehabilitation: 'Neurorehabilitation',
};

describe('resolveBlogThemeTags', () => {
  it('pairs each theme id with its label, in the order the post lists them', () => {
    expect(resolveBlogThemeTags(['neurorehabilitation', 'pain-science'], LABELS)).toEqual([
      { id: 'neurorehabilitation', label: 'Neurorehabilitation' },
      { id: 'pain-science', label: 'Pain Science' },
    ]);
  });

  it('drops an id the label map does not know, rather than emitting a raw id', () => {
    expect(resolveBlogThemeTags(['pain-science', 'retired-theme'], LABELS)).toEqual([
      { id: 'pain-science', label: 'Pain Science' },
    ]);
  });

  it('returns nothing when the post has no themes', () => {
    expect(resolveBlogThemeTags(undefined, LABELS)).toEqual([]);
    expect(resolveBlogThemeTags([], LABELS)).toEqual([]);
  });

  it('returns nothing when no label map is given — a surface that opts out of tags', () => {
    expect(resolveBlogThemeTags(['pain-science'], undefined)).toEqual([]);
  });
});
