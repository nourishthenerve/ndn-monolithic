// 2026-09-06: the account panels each render their own `<h2>`, which was
// right while every one of them owned a page — an `<h1>` page title with one
// `<h2>` panel under it.
//
// The dashboard now gathers several of them into named sections ("Personal
// details", "Account"), and a panel that insists on `<h2>` inside a section
// whose own heading is an `<h2>` reads as a *sibling* of that section rather
// than as something inside it. axe does not object — nothing is skipped —
// but the document outline is what a screen-reader user navigates by, and a
// flat one is the difference between "four sections" and "eleven headings".
//
// So each panel takes the level it should render at, defaulting to the 2 it
// has always used. The standalone pages pass nothing and are unchanged; the
// dashboard passes 3. Exactly the seam `LiveBlogList`/`LiveWorkshopList`
// already grew for the landing page's content strips.

/** The levels a panel heading may take — never `1`, which belongs to the page. */
export type PanelHeadingLevel = 2 | 3 | 4 | 5 | 6;

/**
 * One level deeper, for a panel that nests a heading inside its own — e.g.
 * `ClinicalRecordTimeline`'s per-version headings under its panel heading.
 *
 * Clamped at 6 rather than allowed to overflow: HTML has no `<h7>`, and a
 * heading that silently vanished would be a worse outcome than one that is
 * merely deeper than ideal.
 */
export function nestedHeadingLevel(level: PanelHeadingLevel): PanelHeadingLevel {
  return level >= 6 ? 6 : ((level + 1) as PanelHeadingLevel);
}
