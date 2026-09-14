// 2026-09-14: a post's stored theme ids → display tags, shared by every
// surface that shows them: the listing cards (`LiveBlogList`), the prerendered
// article (`blog/[slug].astro`) and the live fallback article
// (`LiveBlogPost`). One function so a post's tags read identically wherever
// they appear, and so the "drop an id with no label" rule — an unknown or
// retired theme — lives in one place rather than four.
//
// Deliberately free of `@ndn/i18n`: it takes an already-resolved id→label map
// (`blogThemeLabels`) rather than calling `t()` itself, so a client island can
// import it without pulling the catalogue into the decision — the same
// discipline `LiveBlogList` states for why it receives `themeLabels` as a prop.

export interface BlogThemeTag {
  readonly id: string;
  readonly label: string;
}

/**
 * A post's themes as display tags, in the post's own order, dropping any id
 * `labels` has no entry for — an unknown or retired theme — rather than
 * showing a raw id. Returns `[]` when the post has no themes or no label map
 * was given (a surface that opts out of tags).
 */
export function resolveBlogThemeTags(
  themes: readonly string[] | undefined,
  labels: Readonly<Record<string, string>> | undefined,
): readonly BlogThemeTag[] {
  if (!themes || !labels) {
    return [];
  }
  return themes.flatMap((id) => {
    const label = labels[id];
    return label === undefined ? [] : [{ id, label }];
  });
}
