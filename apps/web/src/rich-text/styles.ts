// 2026-09-06: two stylesheets as exported strings, the shape
// `calendar-styles.ts` and `packages/ui`'s `primitiveStylesCss` already use —
// testable as text, and injected with one style set:html, which is what this
// site's CSP requires of anything an island would otherwise try to ship
// inline.
//
// **They are deliberately two.** `proseStylesCss` is the published look of a
// post and belongs on every page that renders one, reader-facing and signed
// out. `richTextEditorStylesCss` is the toolbar and the writing surface and
// belongs only on the two authoring pages. The editor loads both, which is
// the whole point of the split: what an author sees while typing is styled by
// the same rules as what a reader gets, so the preview is not a second
// opinion about the same markup.
//
// No backtick anywhere inside either string — they are template literals, and
// one would end the stylesheet mid-rule. (The same note calendar-styles.ts
// carries, for the same mistake made twice on the landing page.)

/**
 * The published look of a formatted post.
 *
 * Scoped under one class rather than written as bare element selectors,
 * because these rules meet markup nobody reviewed: an author can nest a list
 * inside a quote inside a table cell, and a bare h2 rule would also restyle
 * every heading on every page that happens to include this file.
 */
export const proseStylesCss = `
/* 2026-09-07: a measure. An article used to set as wide as the page column
   gave it — 68rem, which is around 150 characters a line at body size, and
   roughly twice what anyone can read without losing their place returning to
   the left margin. The cap is on the container rather than on p, so a list, a
   quote and a table all sit inside the same column as the paragraphs they
   belong with; anything genuinely wider than the measure (a wide table) still
   scrolls in its own box, which it already did. */
/* 2026-09-09: through a custom property, because this class is worn by two
   different kinds of thing. On a published page .ndn-prose is the article,
   and capping it is the whole point. In the composer it is also the writing
   surface - a form control, sitting directly under a toolbar that spans the
   full column - and capping that is what the owner reported: the text box
   not having the same width as the formatting bar above it. Measured in
   Chromium before the fix: toolbar 1088px, surface 724px.

   So the editor sets --ndn-prose-measure to none on the box and puts the
   real measure back on the content inside its preview, where it belongs.
   Nothing on a reader-facing page passes the property, so every published
   article keeps exactly the measure it had. */
.ndn-prose {
  max-width: var(--ndn-prose-measure, 68ch);
}

.ndn-prose > *:first-child {
  margin-block-start: 0;
}

.ndn-prose > *:last-child {
  margin-block-end: 0;
}

.ndn-prose p {
  margin-block: 0 1rem;
  line-height: 1.7;
}

/* Two levels down from the page title, which is the document's own h1 — the
   editor demotes a pasted h1 to h2 for exactly this reason.

   2026-09-07: these carry the display serif too. An article's own headings
   are the one place where prose written by a clinician meets the site's
   typography, and a sans h2 under a serif h1 read as two documents. Only the
   headings — the body of a post stays Inter, because that is what a reader
   works through paragraph after paragraph. */
.ndn-prose h2,
.ndn-prose h3,
.ndn-prose h4 {
  font-family: var(--ndn-font-family-display);
  font-weight: var(--ndn-font-weight-display);
  color: var(--ndn-color-text);
}

.ndn-prose h2 {
  margin-block: 2.25rem 0.75rem;
  font-size: 1.75rem;
  line-height: 1.2;
}

.ndn-prose h3 {
  margin-block: 1.75rem 0.5rem;
  font-size: 1.375rem;
  line-height: 1.25;
}

.ndn-prose h4 {
  margin-block: 1.5rem 0.5rem;
  font-size: 1.125rem;
}

.ndn-prose ul,
.ndn-prose ol {
  margin-block: 0 1rem;
  padding-inline-start: 1.5rem;
  line-height: 1.7;
}

.ndn-prose li {
  margin-block-end: 0.375rem;
}

/* Nested lists read as one run of text without this, since the outer list
   already carries the bottom margin. */
.ndn-prose li > ul,
.ndn-prose li > ol {
  margin-block: 0.375rem 0;
}

.ndn-prose blockquote {
  margin-block: 0 1.25rem;
  margin-inline: 0;
  padding-inline-start: 1.125rem;
  border-inline-start: 2px solid var(--ndn-color-accent);
  color: var(--ndn-color-text-muted);
  font-style: italic;
}

.ndn-prose pre {
  margin-block: 0 1.25rem;
  padding: 0.875rem 1rem;
  border-radius: 0.5rem;
  background-color: var(--ndn-color-neutral-soft);
  /* A code block is the one place in an article where a line must not be
     re-flowed, so it scrolls in its own box rather than widening the page. */
  overflow-x: auto;
  white-space: pre;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9375rem;
  line-height: 1.55;
}

.ndn-prose code {
  padding-inline: 0.25rem;
  border-radius: 0.25rem;
  background-color: var(--ndn-color-neutral-soft);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9375em;
}

.ndn-prose pre code {
  padding: 0;
  background: none;
  font-size: inherit;
}

/* 2026-09-09: colour, which reaches the page as an inline style on a
   <span> - the one element in this policy that carries no meaning of its
   own. The rule exists to say that explicitly and to stop the element
   inheriting anything surprising: the declaration the author chose is the
   only thing that should decide how these words look, and it is already on
   the element. styles.test.ts requires a rule per allowed element for
   exactly this reason - an element with no rule is one nobody thought
   about. */
.ndn-prose span {
  font: inherit;
  color: inherit;
}

/* The default highlight the toolbar offers. A pale accent tint with the body
   text colour left alone, so the pair is the same 4.5:1 the rest of the page
   is held to whatever an author highlights.

   account/rich-text-controls.ts's HIGHLIGHT_COLOR is this same colour as a
   literal hex, because document.execCommand('hiliteColor', ...) is handed a
   colour and cannot resolve a custom property. That file's own test asserts
   the two agree rather than leaving it to whoever edits one of them next.
   (No backtick in this block: the file is one template literal.) */
.ndn-prose mark {
  padding-inline: 0.125rem;
  border-radius: 0.125rem;
  background-color: var(--ndn-color-accent-soft);
  color: var(--ndn-color-text);
}

.ndn-prose hr {
  margin-block: 2rem;
  border: 0;
  border-top: 1px solid var(--ndn-color-border-strong);
}

.ndn-prose a {
  color: var(--ndn-color-brand);
  text-decoration: underline;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
  text-decoration-color: var(--ndn-color-border-strong);
}

.ndn-prose img {
  max-width: 100%;
  height: auto;
  border-radius: 0.5rem;
}

.ndn-prose figure {
  margin-block: 0 1.5rem;
  margin-inline: 0;
}

.ndn-prose figcaption {
  margin-block-start: 0.5rem;
  color: var(--ndn-color-text-muted);
  font-size: 0.875rem;
}

/* Author-made tables have no column count anyone planned for, so the wrapper
   the article sits in is what stops one from widening the page. */
.ndn-prose table {
  display: block;
  overflow-x: auto;
  width: 100%;
  margin-block: 0 1.5rem;
  border-collapse: collapse;
  font-size: 0.9375rem;
}

.ndn-prose th,
.ndn-prose td {
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--ndn-color-border-strong);
  text-align: start;
  vertical-align: top;
}

.ndn-prose th {
  background-color: var(--ndn-color-surface-muted);
  font-weight: 600;
}
`;

/** The toolbar, the writing surface and the two insert panels. Authoring pages only. */
export const richTextEditorStylesCss = `
.ndn-rte {
  margin-block: 1rem 1.5rem;
}

.ndn-rte-label {
  margin-block: 0 0.375rem;
  font-weight: 500;
}

.ndn-rte-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 0.75rem;
  padding: 0.5rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 0.5rem 0.5rem 0 0;
  border-block-end: 0;
  background-color: var(--ndn-color-surface-muted);
}

.ndn-rte-group {
  display: flex;
  flex-wrap: wrap;
  gap: 0.125rem;
}

/* Separators between runs of controls, so the toolbar reads as groups rather
   than as thirty identical squares. A border rather than a element of its
   own: nothing should be announced between two buttons. */
.ndn-rte-group + .ndn-rte-group {
  padding-inline-start: 0.75rem;
  border-inline-start: 1px solid var(--ndn-color-border-strong);
}

.ndn-rte-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* WCAG 2.2 SC 2.5.8 puts the floor at 24px; these sit above it with the
     0.125rem gap counting toward the spacing exception. */
  min-width: 2rem;
  min-height: 2rem;
  padding-inline: 0.375rem;
  border: 1px solid transparent;
  border-radius: 0.375rem;
  background: none;
  color: var(--ndn-color-text);
  font: inherit;
  font-size: 0.875rem;
  line-height: 1;
  cursor: pointer;
}

.ndn-rte-button:hover:not(:disabled) {
  border-color: var(--ndn-color-border-strong);
  background-color: var(--ndn-color-surface-raised);
}

.ndn-rte-button:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 1px;
}

/* The pressed state has to survive a hover, or a toggled-on button stops
   looking toggled the moment the pointer is over it. */
.ndn-rte-button[aria-pressed='true'],
.ndn-rte-button[aria-pressed='true']:hover {
  border-color: var(--ndn-color-brand);
  background-color: var(--ndn-color-brand-soft);
  color: var(--ndn-color-brand-strong);
}

.ndn-rte-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ndn-rte-icon {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
}

.ndn-rte-surface,
.ndn-rte-preview {
  /* 2026-09-09: the box fills the column, exactly as the toolbar above it
     does. .ndn-prose caps itself at a 68ch measure, which is right for an
     article and wrong for a control: it made the writing surface 724px
     under a 1088px toolbar, which is what the owner reported. The measure
     is not lost, only moved - see .ndn-rte-preview-body, which puts it back
     on the content of the preview, where a measure is a truthful statement
     about the published page rather than a narrow box to type in. */
  --ndn-prose-measure: none;
  box-sizing: border-box;
  width: 100%;
  min-height: 18rem;
  padding: 1rem 1.125rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 0 0 0.5rem 0.5rem;
  background-color: var(--ndn-color-surface-raised);
  /* An author is writing an article, not filling in a field: the surface
     should read at the size the published page reads at. */
  font-size: 1rem;
  overflow-wrap: break-word;
}

.ndn-rte-surface:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: -2px;
}

.ndn-rte-preview {
  background-color: var(--ndn-color-surface);
}

/* The preview's *content*, which is a published article and so keeps the
   published measure. The box around it stays the width of the toolbar, so
   switching to preview does not make the editor change shape. */
.ndn-rte-preview-body {
  max-width: 68ch;
}

.ndn-rte-preview-notice {
  margin-block: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-block-end: 0;
  background-color: var(--ndn-color-brand-wash);
  font-size: 0.875rem;
}

.ndn-rte-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-block-end: 0;
  background-color: var(--ndn-color-surface-raised);
}

.ndn-rte-panel--stacked {
  flex-direction: column;
  align-items: stretch;
}

.ndn-rte-panel-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}

.ndn-rte-panel-hint {
  margin: 0;
  color: var(--ndn-color-text-muted);
  font-size: 0.875rem;
}

.ndn-rte-panel input[type='text'] {
  flex: 1 1 16rem;
  min-height: 2.5rem;
  padding-inline: 0.625rem;
  border: 1px solid var(--ndn-color-text-muted);
  border-radius: 0.5rem;
  font: inherit;
}

.ndn-rte-panel-action {
  min-height: 2.5rem;
  padding-inline: 0.875rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 999px;
  background-color: var(--ndn-color-surface-raised);
  color: var(--ndn-color-text);
  font: inherit;
  cursor: pointer;
}

.ndn-rte-panel-action:hover:not(:disabled) {
  border-color: var(--ndn-color-brand);
}

.ndn-rte-panel-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ndn-rte-panel-action:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

/* A grid of colours rather than a native colour input. Sized so a swatch is
   a comfortable target on its own (WCAG 2.2 SC 2.5.8 asks 24px; these are
   32px) and so the whole palette is visible without scrolling - the point of
   a closed palette is that an author can see every choice at once. */
.ndn-rte-swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.ndn-rte-swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  padding: 0;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 0.375rem;
  background-color: var(--ndn-color-surface-raised);
  font-weight: 700;
  font-size: 0.9375rem;
  line-height: 1;
  cursor: pointer;
}

.ndn-rte-swatch:hover {
  border-color: var(--ndn-color-brand);
  transform: translateY(-1px);
}

.ndn-rte-swatch:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

.ndn-rte-hint {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 0.5rem;
  margin-block: 0.375rem 0;
  color: var(--ndn-color-text-muted);
  font-size: 0.875rem;
}

.ndn-rte-count {
  font-variant-numeric: tabular-nums;
}
`;
