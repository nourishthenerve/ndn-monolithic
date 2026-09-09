// 2026-09-09: the blog and workshop authoring pages' own stylesheet.
//
// The owner, on the blog composer: *"the browse and save etc buttons doesnt
// have a nice bootstrap look. Finally, the your blog post table is not a nice
// table. Basically, make it really a super advanced page so that all kind of
// formatting is possible before the blog post goes online."*
//
// Most of that request is answered in the components, which now emit
// `packages/ui`'s own classes — `Button` for every action, and the
// `.ndn-input-wrapper`/`.ndn-input-label`/`.ndn-input` stack that puts a
// label above its control instead of beside it. This file is for the parts
// that are not a primitive:
//
//   * **The sheet.** The composer and the list are each a panel on the page
//     rather than a run of fields on bare paper. Same construction, and the
//     same measurements, as `record-styles.ts` gives the four areas of a
//     patient record — the site should not grow two answers to "what does a
//     document-shaped form look like".
//   * **The Browse button**, which is not a button this app renders at all.
//     It belongs to `<input type="file">` and is reachable only through
//     `::file-selector-button`. Styling it there keeps the native control —
//     and its keyboard behaviour, and its "no file chosen" text — while
//     making the part a person actually clicks look like every other pill on
//     the site. The usual alternative is a `<label>` dressed as a button with
//     the input visually hidden, which looks identical and quietly loses the
//     control's own semantics.
//   * **The table**, which was a bare `<table>`: browser default borders, no
//     padding, columns sized by content, the status as a raw word. It is now
//     the shape `caseload-styles.ts` gives the only other table in the
//     account area.
//
// Held as an exported string for the reasons `caseload-styles.ts` and
// `record-styles.ts` are: unit-testable as text, injected by the page with
// one `<style set:html>` (this site's CSP admits no other kind), and out of
// the client bundle because the page needs it at build time only.
//
// No backticks anywhere inside: this is a template literal, and one would end
// it mid-stylesheet.

export const authoringStylesCss = `
/* ------------------------------------------------------------------ *
 * The sheet - one for the composer, one for the list beneath it.
 * ------------------------------------------------------------------ */
.ndn-authoring-sheet {
  margin-block: 0 2rem;
  padding-inline: 1.75rem;
  padding-block-end: 1.75rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.875rem;
  background-color: var(--ndn-color-surface-raised);
}

/* The band across the top, full bleed by a negative inline margin against
   the sheet's own padding. (0,2,1) so it beats h2.ndn-heading's own type
   scale wherever Astro happens to put the two stylesheets. */
.ndn-authoring-sheet > h2.ndn-heading,
.ndn-authoring-sheet > h3.ndn-heading {
  margin-block: 0 1.25rem;
  margin-inline: -1.75rem;
  padding-block: 1rem;
  padding-inline: 1.75rem;
  border-block-end: 1px solid var(--ndn-color-border);
  border-start-start-radius: 0.8125rem;
  border-start-end-radius: 0.8125rem;
  background-color: var(--ndn-color-surface-muted);
  font-size: 1.5rem;
}

.ndn-authoring-intro {
  margin-block: 0 1.5rem;
  max-width: 60ch;
  color: var(--ndn-color-text-muted);
}

/* Every field on the form is an .ndn-input-wrapper, and they stack. A grid
   like the patient record's would be wrong here: a title, an excerpt and a
   keyword line are each one long value, not a pair of short ones. */
.ndn-authoring-sheet .ndn-input-wrapper {
  margin-block: 0 0.25rem;
}

.ndn-authoring-sheet .ndn-input-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
}

.ndn-authoring-sheet .ndn-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 2.625rem;
  font-size: 0.9375rem;
}

/* Hand-written fields, so no .ndn-interactive and no focus ring from it -
   the same restatement caseload-styles.ts makes for its own plain controls. */
.ndn-authoring-sheet .ndn-input:focus-visible,
.ndn-authoring-file:focus-visible,
.ndn-authoring-sheet .ndn-checkbox input:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

/* The sentence under a field explaining what it is for. Quieter than the
   answer above it, because it is instruction rather than content. */
/* The editor's own label, matched to the field labels above and below it.
   It is a <p> rather than a <label> because a contenteditable is not a
   labelable element - the surface points at it with aria-labelledby - so it
   cannot pick up .ndn-input-label by being one. */
.ndn-authoring-sheet .ndn-rte-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
}

.ndn-authoring-hint {
  margin-block: 0 1.5rem;
  max-width: 68ch;
  color: var(--ndn-color-text-muted);
  font-size: 0.875rem;
}

.ndn-authoring-alert {
  margin-block: 0 1rem;
  padding-block: 0.625rem;
  padding-inline: 0.875rem;
  border-inline-start: 3px solid var(--ndn-color-error);
  border-start-end-radius: 0.375rem;
  border-end-end-radius: 0.375rem;
  background-color: var(--ndn-color-error-soft);
  color: var(--ndn-color-error);
  font-size: 0.875rem;
}

/* What will actually be stored, shown back as chips rather than a bulleted
   list: a keyword is a search partition, and a chip reads as one value in a
   way a bullet does not. */
.ndn-authoring-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-block: 0 1.5rem;
  padding: 0;
  list-style: none;
}

.ndn-authoring-keywords li {
  padding-block: 0.1875rem;
  padding-inline: 0.625rem;
  border-radius: 999px;
  background-color: var(--ndn-color-brand-soft);
  color: var(--ndn-color-brand-strong);
  font-size: 0.8125rem;
  font-weight: 500;
}

.ndn-authoring-publish {
  margin-block: 1.5rem 0.25rem;
}

/* ------------------------------------------------------------------ *
 * The lead image, and the Browse button inside its input.
 * ------------------------------------------------------------------ */
.ndn-authoring-media {
  display: block;
  margin-block: 1.5rem 0;
  padding-block-start: 1.5rem;
  border-block-start: 1px solid var(--ndn-color-border);
}

.ndn-authoring-file {
  box-sizing: border-box;
  width: 100%;
  padding: 0.5rem;
  border: 1px dashed var(--ndn-color-border-strong);
  border-radius: 0.5rem;
  background-color: var(--ndn-color-surface);
  color: var(--ndn-color-text-muted);
  font: inherit;
  font-size: 0.875rem;
}

/* The pill the person actually clicks. Every declaration here is one
   .ndn-button already sets - it cannot be shared, because this element is
   generated by the browser inside the input's shadow tree and no class of
   ours can ever reach it. */
.ndn-authoring-file::file-selector-button {
  margin-inline-end: 0.75rem;
  padding-block: 0.375rem;
  padding-inline: 0.875rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 999px;
  background-color: var(--ndn-color-surface-raised);
  color: var(--ndn-color-brand);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--ndn-motion-duration-fast) ease,
    border-color var(--ndn-motion-duration-fast) ease,
    color var(--ndn-motion-duration-fast) ease;
}

.ndn-authoring-file::file-selector-button:hover {
  border-color: var(--ndn-color-brand);
  background-color: var(--ndn-color-brand-wash);
  color: var(--ndn-color-brand-strong);
}

.ndn-authoring-file:disabled::file-selector-button {
  opacity: 0.6;
  cursor: not-allowed;
}

.ndn-authoring-media-preview {
  display: block;
  margin-block: 0.75rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.5rem;
}

/* The editor's own file input, inside the insert-image panel, is the same
   control doing the same job. */
.ndn-rte-panel input[type='file'] {
  flex: 1 1 16rem;
  padding: 0.4375rem;
  border: 1px dashed var(--ndn-color-border-strong);
  border-radius: 0.5rem;
  background-color: var(--ndn-color-surface);
  font: inherit;
  font-size: 0.875rem;
}

.ndn-rte-panel input[type='file']::file-selector-button {
  margin-inline-end: 0.75rem;
  padding-block: 0.3125rem;
  padding-inline: 0.75rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 999px;
  background-color: var(--ndn-color-surface-raised);
  color: var(--ndn-color-brand);
  font: inherit;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
}

.ndn-rte-panel input[type='file']::file-selector-button:hover {
  border-color: var(--ndn-color-brand);
  background-color: var(--ndn-color-brand-wash);
}

/* ------------------------------------------------------------------ *
 * What has already been written.
 * ------------------------------------------------------------------ */
.ndn-authored-scroll {
  overflow-x: auto;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 0.75rem;
  background-color: var(--ndn-color-surface-raised);
}

.ndn-authored-table {
  width: 100%;
  /* Wide enough that a real post title is readable beside a status and an
     action; below this the container scrolls rather than the page. */
  min-width: 34rem;
  border-collapse: collapse;
  text-align: start;
}

.ndn-authored-table th {
  padding-block: 0.625rem;
  padding-inline: 1rem;
  border-block-end: 1px solid var(--ndn-color-border);
  background-color: var(--ndn-color-surface-muted);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-align: start;
  color: var(--ndn-color-text-muted);
}

.ndn-authored-table td {
  padding-block: 0.75rem;
  padding-inline: 1rem;
  border-block-start: 1px solid var(--ndn-color-border);
  vertical-align: middle;
}

.ndn-authored-table tbody tr:hover {
  background-color: var(--ndn-color-brand-wash);
}

/* The title column is the widest thing here and the only one that grows. */
.ndn-authored-table td:first-child {
  width: 100%;
  font-weight: 500;
}

.ndn-authored-title {
  color: var(--ndn-color-brand);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.ndn-authored-title:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

/* Published or not, as a shape and a colour before it is a word - the same
   construction the caseload's own status column uses, and the same tint and
   foreground tokens, which packages/ui's color.test.ts walks to prove every
   such pair clears 4.5:1. */
.ndn-authored-status {
  display: inline-block;
  padding-block: 0.125rem;
  padding-inline: 0.5rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 500;
  white-space: nowrap;
}

.ndn-authored-status--published {
  background-color: var(--ndn-color-brand-soft);
  color: var(--ndn-color-brand-strong);
}

.ndn-authored-status--draft {
  background-color: var(--ndn-color-neutral-soft);
  color: var(--ndn-color-text-muted);
}

/* ------------------------------------------------------------------ *
 * Narrow viewports. The sheet keeps its shape; the margins close up, and
 * the band's negative inline margin has to close with them.
 * ------------------------------------------------------------------ */
@media (max-width: 40rem) {
  .ndn-authoring-sheet {
    padding-inline: 1rem;
    padding-block-end: 1.25rem;
    border-radius: 0.625rem;
  }

  .ndn-authoring-sheet > h2.ndn-heading,
  .ndn-authoring-sheet > h3.ndn-heading {
    margin-inline: -1rem;
    padding-inline: 1rem;
    border-start-start-radius: 0.5625rem;
    border-start-end-radius: 0.5625rem;
  }
}
`;
