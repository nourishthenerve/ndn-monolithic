// 2026-09-11: the testimonial-curation page's stylesheet.
//
// The owner, of the workshop and testimonial pages: *"the buttons ... is not
// styled the way other buttons are styled ... format these two pages to
// match the rest of the theme."* The workshop composer only needed the
// authoring classes it had been missing; this page had a set of
// `.ndn-curation-*` class names on its markup and **no stylesheet defining a
// single one of them** — a run of default `<blockquote>`s, `<fieldset>`s and
// bare `<button>`s. Its buttons are now the site's own pills (the component
// carries `.ndn-button` on them, the same as everywhere else), and this
// dresses the list they sit in.
//
// The section itself is a `.ndn-record-area` sheet, drawn by
// `record-styles.ts` which the page also injects — so the heading band and
// the "not yet curated" note read as the same document the dashboard does.
// What is here is only the part that sheet has no shape for: the cards of a
// quote and its placement, and the ordered list of the featured ones.
//
// Held as an exported string for the reasons `caseload-styles.ts` is —
// testable as text, injected by the page with one `<style set:html>`, and
// out of the client bundle because the page needs it at build time only.
//
// No backticks anywhere inside: this is a template literal, and one would
// end it mid-stylesheet.

export const curationStylesCss = `
/* One card per published testimonial: the quote on one side, the placement
   choice on the other where there is room for them to sit together. */
.ndn-curation-list {
  display: grid;
  gap: 1rem;
  margin-block: 1.5rem 0;
  padding: 0;
  list-style: none;
}

.ndn-curation-item {
  display: grid;
  gap: 1rem;
  padding: 1.25rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.75rem;
  background-color: var(--ndn-color-surface-muted);
}

@media (min-width: 44rem) {
  .ndn-curation-item {
    grid-template-columns: minmax(0, 1fr) minmax(14rem, 20rem);
    align-items: start;
  }
}

.ndn-curation-item blockquote {
  margin: 0;
}

.ndn-curation-item blockquote p {
  margin: 0 0 0.5rem;
  font-size: 1.0625rem;
  line-height: 1.5;
}

.ndn-curation-item blockquote footer {
  font-size: 0.8125rem;
  color: var(--ndn-color-text-muted);
}

/* The placement radios, gathered into their own small panel so the choice
   reads as one control rather than three stray options. */
.ndn-curation-item fieldset {
  margin: 0;
  padding-block: 0.625rem 0.75rem;
  padding-inline: 1rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.625rem;
  background-color: var(--ndn-color-surface-raised);
}

.ndn-curation-item legend {
  padding-inline: 0.375rem;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
}

.ndn-curation-item fieldset label {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  padding-block: 0.25rem;
  font-size: 0.9375rem;
}

/* The order of the featured testimonials — a row each, the name on the left
   and the move controls on the right. */
.ndn-curation-order {
  display: grid;
  gap: 0.5rem;
  margin-block: 1rem 0;
  padding: 0;
  list-style: none;
}

.ndn-curation-order li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding-block: 0.625rem;
  padding-inline: 0.875rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.625rem;
  background-color: var(--ndn-color-surface-muted);
}

.ndn-curation-order-name {
  margin-inline-end: auto;
  font-weight: 500;
}

.ndn-curation-order-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
`;
