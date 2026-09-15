// 2026-09-14: the pending-approvals queue's stylesheet.
//
// The owner asked for "a table like format where he simply has to click
// Accept" above the patient dashboard. It shares the caseload table's visual
// language deliberately — the two sit one above the other, and a reader
// should see one surface, not two designs — so the surround, borders, caption
// and header treatment are the same as `caseload-styles.ts`. What is its own
// is the Accept button (the row's primary action, tinted so it reads before
// the reader has parsed the row) and the collapse: a row fades on a decision
// and is then dropped from the list.
//
// Held as an exported string for the same reasons `caseload-styles.ts` is —
// testable as text, injected by the page with one `<style set:html>`, and out
// of the client bundle because the page needs it at build time only.
//
// No backticks anywhere inside: this is a template literal, and one would end
// it mid-stylesheet.

export const pendingApprovalsStylesCss = `
.ndn-approvals {
  margin-block-start: 1rem;
}

.ndn-approvals-scroll {
  overflow-x: auto;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 0.75rem;
  background-color: var(--ndn-color-surface-raised);
}

.ndn-approvals-table {
  width: 100%;
  min-width: 40rem;
  border-collapse: collapse;
  text-align: start;
}

.ndn-approvals-caption {
  padding-block: 0.875rem;
  padding-inline: 1rem;
  font-family: var(--ndn-font-family-display);
  font-weight: var(--ndn-font-weight-display);
  font-size: 1.25rem;
  text-align: start;
  border-block-end: 1px solid var(--ndn-color-border);
}

.ndn-approvals-table th {
  padding-block: 0.625rem;
  padding-inline: 1rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  text-align: start;
  color: var(--ndn-color-text-muted);
  background-color: var(--ndn-color-surface-muted);
  border-block-end: 1px solid var(--ndn-color-border);
}

.ndn-approvals-table td {
  padding-block: 0.75rem;
  padding-inline: 1rem;
  vertical-align: middle;
  border-block-start: 1px solid var(--ndn-color-border);
}

/* The collapse the owner asked for: a decided row fades before it is dropped
   from the list. Opacity only — a <tr>'s height does not animate reliably —
   which reads as the row leaving. Honoured only where motion is welcome. */
.ndn-approvals-row {
  transition: opacity var(--ndn-motion-duration-fast) ease;
}

.ndn-approvals-row--removing {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .ndn-approvals-row {
    transition: none;
  }
}

.ndn-approvals-unassigned {
  color: var(--ndn-color-text-muted);
  font-style: italic;
}

.ndn-approvals-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.ndn-approvals-button {
  min-height: 2.25rem;
  padding-block: 0.375rem;
  padding-inline: 0.875rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 999px;
  background-color: var(--ndn-color-surface-raised);
  color: var(--ndn-color-text);
  font: inherit;
  font-size: 0.875rem;
  white-space: nowrap;
  cursor: pointer;
  transition: border-color var(--ndn-motion-duration-fast) ease,
    background-color var(--ndn-motion-duration-fast) ease,
    color var(--ndn-motion-duration-fast) ease;
}

/* Accept is the row's primary action — the one the owner wants clicked over
   and over — so it carries the brand fill rather than the outline the decline
   button keeps. The pair is a dark foreground on a brand tint, the same
   construction the caseload status badges use and the same one color.test.ts
   proves clears 4.5:1. */
.ndn-approvals-button--accept {
  border-color: var(--ndn-color-brand);
  background-color: var(--ndn-color-brand-soft);
  color: var(--ndn-color-brand-strong);
  font-weight: 600;
}

.ndn-approvals-button:hover:not(:disabled) {
  border-color: var(--ndn-color-brand);
  background-color: var(--ndn-color-brand-wash);
  color: var(--ndn-color-brand-strong);
}

.ndn-approvals-button:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* Plain <button>s rather than packages/ui primitives, so they inherit none
   of .ndn-interactive's focus styling — restated here. */
.ndn-approvals-button:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

.ndn-approvals-actions [role='alert'] {
  color: var(--ndn-color-error);
  font-size: 0.8125rem;
}
`;
