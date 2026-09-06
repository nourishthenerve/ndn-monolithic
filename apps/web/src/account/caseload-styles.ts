// 2026-09-06: the caseload table's stylesheet.
//
// The owner: *"for Patient Dashboard, I need a nicely looking table so that I
// see which patients are assigned for a given clinician."*
//
// The table already held that answer — patient, status, assigned clinician,
// and a picker to change it — and had **no styling whatsoever**: browser
// default borders, no padding, columns sized by content, controls sitting
// flush against text. On a page whose whole job is scanning down a
// clinician column looking for a name, that is the difference between
// reading it and parsing it.
//
// Held as an exported string for the same reasons `calendar-styles.ts` is —
// testable as text, injected by the page with one `<style set:html>`, and
// out of the client bundle because the page needs it at build time only.
//
// No backticks anywhere inside: this is a template literal, and one would
// end it mid-stylesheet.

export const caseloadStylesCss = `
.ndn-caseload {
  margin-block-start: 1rem;
}

/* Two labelled figures, paired into columns by grid rather than by wrapper
   elements — see the component for why there are no <div>s in that <dl>. */
.ndn-caseload-counts {
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: auto auto;
  justify-content: start;
  gap: 0.125rem 2.5rem;
  margin-block: 0 1.5rem;
}

.ndn-caseload-counts dt {
  font-size: 0.8125rem;
  color: var(--ndn-color-text-muted);
}

.ndn-caseload-counts dd {
  margin: 0;
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}

.ndn-caseload-scroll {
  overflow-x: auto;
  border: 1px solid rgba(0, 0, 0, 0.1);
  border-radius: 0.5rem;
  background-color: #ffffff;
}

.ndn-caseload-table {
  width: 100%;
  /* Wide enough that the clinician column is still readable beside a
     patient name and a status; narrower than this and the picker wraps
     into an unreadable stack. Below it the container scrolls. */
  min-width: 46rem;
  border-collapse: collapse;
  text-align: start;
}

.ndn-caseload-caption {
  padding-block: 0.875rem;
  padding-inline: 1rem;
  font-weight: 700;
  text-align: start;
  border-block-end: 1px solid rgba(0, 0, 0, 0.1);
}

.ndn-caseload-table th {
  padding-block: 0.625rem;
  padding-inline: 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-align: start;
  color: var(--ndn-color-text-muted);
  background-color: #f6f8f8;
  border-block-end: 1px solid rgba(0, 0, 0, 0.1);
}

.ndn-caseload-table td {
  padding-block: 0.75rem;
  padding-inline: 1rem;
  vertical-align: middle;
  border-block-start: 1px solid rgba(0, 0, 0, 0.07);
}

.ndn-caseload-table tbody tr:hover {
  background-color: rgba(10, 110, 90, 0.04);
}

.ndn-caseload-name {
  font-weight: 500;
  color: var(--ndn-color-brand);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.ndn-caseload-unassigned {
  color: var(--ndn-color-text-muted);
  font-style: italic;
}

/* The column a clinician scans first, so status reads as a shape and a
   colour before it reads as a word. Every pair below is a dark foreground on
   a light tint of the same hue — the same construction the calendar chips
   use, and well clear of 4.5:1. */
.ndn-caseload-status {
  display: inline-block;
  padding-block: 0.125rem;
  padding-inline: 0.5rem;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 500;
  white-space: nowrap;
  background-color: rgba(0, 0, 0, 0.07);
  color: #3f4650;
}

.ndn-caseload-status--approved {
  background-color: rgba(10, 110, 90, 0.12);
  color: #06483b;
}

.ndn-caseload-status--pending {
  background-color: rgba(146, 94, 0, 0.14);
  color: #5c3b00;
}

.ndn-caseload-status--declined,
.ndn-caseload-status--suspended {
  background-color: rgba(179, 38, 30, 0.12);
  color: #8a1d17;
}

.ndn-caseload-select {
  max-width: 12rem;
  min-height: 2.25rem;
  padding-block: 0.25rem;
  padding-inline: 0.5rem;
  border: 1px solid var(--ndn-color-text-muted);
  border-radius: 0.375rem;
  background-color: #ffffff;
  color: var(--ndn-color-text);
  font: inherit;
  font-size: 0.875rem;
}

.ndn-caseload-button {
  min-height: 2.25rem;
  padding-block: 0.375rem;
  padding-inline: 0.75rem;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: 0.375rem;
  background-color: #ffffff;
  color: var(--ndn-color-text);
  font: inherit;
  font-size: 0.875rem;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--ndn-motion-duration-fast) ease;
}

.ndn-caseload-button:hover:not(:disabled) {
  border-color: var(--ndn-color-brand);
}

.ndn-caseload-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* These are plain <button>/<select> elements rather than packages/ui
   primitives, so they inherit none of .ndn-interactive's focus styling. */
.ndn-caseload-button:focus-visible,
.ndn-caseload-select:focus-visible,
.ndn-caseload-name:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

.ndn-caseload-pager {
  display: flex;
  gap: 0.5rem;
  margin-block-start: 1rem;
}
`;
