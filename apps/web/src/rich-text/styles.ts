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
   editor demotes a pasted h1 to h2 for exactly this reason. */
.ndn-prose h2 {
  margin-block: 2rem 0.75rem;
  font-size: 1.5rem;
  line-height: 1.3;
}

.ndn-prose h3 {
  margin-block: 1.75rem 0.5rem;
  font-size: 1.25rem;
  line-height: 1.35;
}

.ndn-prose h4 {
  margin-block: 1.5rem 0.5rem;
  font-size: 1.0625rem;
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
  padding-inline-start: 1rem;
  border-inline-start: 3px solid var(--ndn-color-brand);
  color: var(--ndn-color-text-muted);
  font-style: italic;
}

.ndn-prose pre {
  margin-block: 0 1.25rem;
  padding: 0.875rem 1rem;
  border-radius: 0.5rem;
  background-color: rgba(0, 0, 0, 0.05);
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
  background-color: rgba(0, 0, 0, 0.05);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9375em;
}

.ndn-prose pre code {
  padding: 0;
  background: none;
  font-size: inherit;
}

/* The one highlight the toolbar offers. A pale brand tint with the body text
   colour left alone, so the pair is the same 4.5:1 the rest of the page is
   held to whatever an author highlights. */
.ndn-prose mark {
  padding-inline: 0.125rem;
  border-radius: 0.125rem;
  background-color: #cdeee5;
  color: var(--ndn-color-text);
}

.ndn-prose hr {
  margin-block: 2rem;
  border: 0;
  border-top: 1px solid rgba(0, 0, 0, 0.12);
}

.ndn-prose a {
  color: var(--ndn-color-brand);
  text-decoration: underline;
  text-underline-offset: 0.15em;
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
  border: 1px solid rgba(0, 0, 0, 0.12);
  text-align: start;
  vertical-align: top;
}

.ndn-prose th {
  background-color: rgba(0, 0, 0, 0.04);
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
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: 0.5rem 0.5rem 0 0;
  border-block-end: 0;
  background-color: #f7f8f8;
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
  border-inline-start: 1px solid rgba(0, 0, 0, 0.12);
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
  border-color: rgba(0, 0, 0, 0.16);
  background-color: #ffffff;
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
  background-color: rgba(10, 110, 90, 0.12);
  color: #06483b;
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
  min-height: 18rem;
  padding: 1rem 1.125rem;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: 0 0 0.5rem 0.5rem;
  background-color: #ffffff;
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
  background-color: #fbfbfa;
}

.ndn-rte-preview-notice {
  margin-block: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-block-end: 0;
  background-color: rgba(10, 110, 90, 0.08);
  font-size: 0.875rem;
}

.ndn-rte-panel {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-block-end: 0;
  background-color: #ffffff;
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
  border-radius: 0.375rem;
  font: inherit;
}

.ndn-rte-panel-action {
  min-height: 2.5rem;
  padding-inline: 0.875rem;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: 0.375rem;
  background-color: #ffffff;
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
