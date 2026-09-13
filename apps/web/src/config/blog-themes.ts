// 2026-09-13: the web's view of `@ndn/shared-types`'s blog themes — the same
// twelve ids, paired with their localised labels. The ids are the shared
// source of truth (services/api validates against the identical list); the
// labels are `blog.theme.<id>` catalogue entries, resolved here so a page can
// hand a client island plain strings rather than the `t()` the island cannot
// call at runtime.
//
// Two shapes because two call sites want two things: the composer's checklist
// wants `{ id, label }` in display order, and a listing card wants to look a
// label up by id. Both come from the one ordered `blogThemeIds`, so they can
// never list different themes.
import { t } from '@ndn/i18n';
import type { Locale } from '@ndn/i18n';
import { blogThemeIds } from '@ndn/shared-types';

export interface BlogThemeOption {
  readonly id: string;
  readonly label: string;
}

/** The catalogue key a theme's human label lives at. */
export function blogThemeLabelKey(id: string): string {
  return `blog.theme.${id}`;
}

/** The twelve themes as `{ id, label }`, in display order — the composer's checklist. */
export function blogThemeOptions(locale: Locale): readonly BlogThemeOption[] {
  return blogThemeIds.map((id) => ({ id, label: t(blogThemeLabelKey(id), undefined, locale) }));
}

/** id → label, for turning a post's stored theme ids into tags on a card. */
export function blogThemeLabels(locale: Locale): Readonly<Record<string, string>> {
  return Object.fromEntries(
    blogThemeIds.map((id) => [id, t(blogThemeLabelKey(id), undefined, locale)]),
  );
}
