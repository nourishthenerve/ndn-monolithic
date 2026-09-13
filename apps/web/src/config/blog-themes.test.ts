import { t } from '@ndn/i18n';
import { blogThemeIds } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { blogThemeLabelKey, blogThemeLabels, blogThemeOptions } from './blog-themes.js';

// A theme with no `blog.theme.<id>` catalogue entry is a tag that renders as an
// empty pill and a checkbox with no words beside it — `t()` never throws and
// never shows the raw key, so nothing else would catch it. This is that check.
describe('blog theme labels', () => {
  it('every theme id resolves to a real label', () => {
    for (const id of blogThemeIds) {
      expect(t(blogThemeLabelKey(id)), `${id} has no label`).not.toBe('');
    }
  });

  it('no two themes share a label', () => {
    const labels = blogThemeIds.map((id) => t(blogThemeLabelKey(id)));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('options are every theme, in catalogue order, paired with their labels', () => {
    const options = blogThemeOptions('en');
    expect(options.map((option) => option.id)).toEqual([...blogThemeIds]);
    for (const option of options) {
      expect(option.label).toBe(t(blogThemeLabelKey(option.id)));
    }
  });

  it('labels map every id to its label', () => {
    const labels = blogThemeLabels('en');
    expect(Object.keys(labels).sort()).toEqual([...blogThemeIds].sort());
    expect(labels['neurorehabilitation']).toBe(t('blog.theme.neurorehabilitation'));
  });
});
