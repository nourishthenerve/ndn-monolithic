// 2026-09-08: the patient record's stylesheet — the four named areas drawn
// as a document rather than as a run of unstyled elements.
//
// The owner: *"the patient details, patient assessment form etc are not
// properly formatted. They are lying one after the other in a row. Rather I
// want a pdf looking view so that it doesnt look this ugly. Make it look
// like editable pdf with heading, sections, different font size and color
// and thickness etc."*
//
// Two separate faults sat behind that, and both are answered here.
//
//   * **Every field was `<p><label>…<input></p>` with no class on any of
//     it.** A `<label>` is inline, so the label and its box sat side by
//     side on one line, and the box itself was the browser's default —
//     Arial-ish, square, hairline grey. That is the "lying one after the
//     other in a row". The components now emit `packages/ui`'s own
//     `.ndn-input-wrapper`/`.ndn-input-label`/`.ndn-input` (the same three
//     `PatientProfile` already borrows), which stacks the label above its
//     control; this file arranges those stacks into a grid and gives the
//     label the small letter-spaced caps a form field carries on paper.
//   * **Nothing said where one area ended and the next began.** Four
//     `<h2>`s on the page ground, with 600-odd controls between them, is
//     not a document. Each area is now a sheet — raised surface, hairline
//     border, its heading in a tinted band across the top — so the page
//     reads as four pages of a record rather than as one scroll.
//
// The type hierarchy is the "different font size and color and thickness"
// asked for, and it is deliberately three voices rather than five:
//
//   | Area title      | Cormorant 1.5rem, 600, in a tinted band     |
//   | Group heading   | Inter 0.8125rem, 700, caps, brand-strong    |
//   | Field label     | Inter 0.75rem, 600, caps, muted             |
//   | Answer          | Inter 0.9375rem, 500, full-strength text    |
//
// A group heading is set in the *sans* face on purpose: the assessment form
// has 44 of them, and 44 serif sub-titles under a serif area title is a page
// with no hierarchy at all. Sans caps reads as a rule on a form, which is
// what it is.
//
// ## Specificity, not source order
//
// Every selector that competes with `primitiveStylesCss` is written to win
// on specificity — `.ndn-record-fields .ndn-input-label` (0,2,0) over
// `.ndn-input-label` (0,1,0), `.ndn-record-area > h2.ndn-heading` (0,2,1)
// over `h2.ndn-heading` (0,1,1), `.ndn-heading.ndn-record-group` (0,2,0)
// over `h4.ndn-heading` (0,1,1). The two stylesheets are injected by
// different parts of the layout and Astro decides the order they land in;
// the landing page's own stylesheet documents the same trap.
//
// Held as an exported string for the reasons `caseload-styles.ts` and
// `dashboard-styles.ts` are: unit-testable as text, injected by the page
// with one `<style set:html>` (this site's CSP admits no other kind), and
// out of the client bundle because the page needs it at build time only.
//
// No backticks anywhere inside: this is a template literal, and one would
// end it mid-stylesheet.

export const patientRecordStylesCss = `
/* ------------------------------------------------------------------ *
 * The sheet. One per named area of the record.
 * ------------------------------------------------------------------ */
.ndn-record-area {
  margin-block: 0 2rem;
  padding-inline: 1.75rem;
  padding-block-end: 1.75rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.875rem;
  background-color: var(--ndn-color-surface-raised);
}

/* Astro wraps every client:only island in an <astro-island>, which is an
   unknown element and therefore inline. Its block children still lay out
   correctly, but an inline box between the sheet and its contents means no
   margin on the island itself and a stray line box under the last one.
   Scoped to this sheet rather than set on astro-island globally, which
   would change how the site nav's own island lays out — the same call, for
   the same reason, the landing page's grid makes. */
.ndn-record-area > astro-island {
  display: block;
}

/* The band across the top of the sheet. Full bleed by a negative inline
   margin against the sheet's own padding, so the rule under it reaches
   both edges; the radius is the sheet's less its 1px border, or the
   heading's corners sit proud of it. */
.ndn-record-area > h2.ndn-heading {
  margin-block: 0 1.5rem;
  margin-inline: -1.75rem;
  padding-block: 1rem;
  padding-inline: 1.75rem;
  border-block-end: 1px solid var(--ndn-color-border);
  border-start-start-radius: 0.8125rem;
  border-start-end-radius: 0.8125rem;
  background-color: var(--ndn-color-surface-muted);
  color: var(--ndn-color-text);
  font-size: 1.5rem;
  letter-spacing: 0.005em;
}

/* One section of the record inside a sheet — the AssessmentForm's own
   <section>. It carries no border of its own: the sheet is the boundary,
   and a box inside a box is how a form starts looking like a spreadsheet. */
.ndn-record-section + .ndn-record-section {
  margin-block-start: 2rem;
  padding-block-start: 1.5rem;
  border-block-start: 1px solid var(--ndn-color-border);
}

/* The revision stamp, top-right of the sheet the way a document's is. */
.ndn-record-version {
  margin-block: 0 1rem;
  text-align: end;
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
  font-variant-numeric: tabular-nums;
}

.ndn-record-backlink {
  margin-block: 0 1.25rem;
  font-size: 0.875rem;
}

/* Whatever the form has to say about itself — "read only", "no next
   appointment". A tinted rule down the inline start, so it reads as an
   annotation on the document rather than as one of its answers. */
.ndn-record-note {
  margin-block: 0 1.25rem;
  padding-block: 0.625rem;
  padding-inline: 0.875rem;
  border-inline-start: 3px solid var(--ndn-color-accent-soft);
  border-start-end-radius: 0.375rem;
  border-end-end-radius: 0.375rem;
  background-color: var(--ndn-color-surface-muted);
  color: var(--ndn-color-text-muted);
  font-size: 0.875rem;
}

/* ------------------------------------------------------------------ *
 * Headings inside a sheet.
 * ------------------------------------------------------------------ */

/* A numbered heading from the assessment template — 44 of them in the
   clinician's section alone. Sans, small, heavy, letter-spaced and in the
   brand's darkest tint: a rule across the form rather than a title. */
.ndn-heading.ndn-record-group {
  margin-block: 2rem 0.875rem;
  padding-block-end: 0.4375rem;
  border-block-end: 2px solid var(--ndn-color-brand-soft);
  font-family: var(--ndn-font-family-base);
  font-size: 0.8125rem;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--ndn-color-brand-strong);
}

/* A panel's own title where the page did not already write one — the
   booking form, the attachments block. Serif, but a step under the band. */
.ndn-heading.ndn-record-subheading {
  margin-block: 1.75rem 0.75rem;
  font-size: 1.1875rem;
}

/* ------------------------------------------------------------------ *
 * Answers already given, that this reader may not change.
 * ------------------------------------------------------------------ */

/* Ruled rows, label left and answer right — the shape a record has on
   paper. One column rather than two: a two-column pairing leaves the last
   row's rule running half way across whenever the count is odd, which
   looks like a rendering fault rather than a layout. */
.ndn-record-facts {
  display: grid;
  grid-template-columns: minmax(7rem, 14rem) minmax(0, 1fr);
  margin-block: 0 1.5rem;
  border-block-start: 1px solid var(--ndn-color-border);
}

.ndn-record-facts dt {
  padding-block: 0.5625rem;
  padding-inline-end: 1rem;
  border-block-end: 1px solid var(--ndn-color-border);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  line-height: 1.5;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
}

.ndn-record-facts dd {
  margin: 0;
  padding-block: 0.5625rem;
  border-block-end: 1px solid var(--ndn-color-border);
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--ndn-color-text);
  /* Answers include email addresses and free text with no spaces in it;
     without this one of them widens the grid and the sheet scrolls. */
  overflow-wrap: anywhere;
}

/* ------------------------------------------------------------------ *
 * Answers this reader may change.
 * ------------------------------------------------------------------ */

/* Two or more fields across, rather than one per line down a 68rem
   column. auto-fit with a 15rem floor, so a phone gets one column and a
   desktop gets three or four without a breakpoint per width. */
.ndn-record-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  align-items: start;
  gap: 1.125rem 1.5rem;
  margin-block: 1rem 0;
}

.ndn-record-fields > .ndn-input-wrapper,
.ndn-record-fields > .ndn-record-field {
  margin: 0;
  /* A grid item's default min-width is auto, which lets a long <select>
     option push its own column wider than the track it was given. */
  min-width: 0;
}

/* Prose, a tick box and a grid each take the whole row: a textarea two
   columns wide and four lines tall is unreadable, and a seven-column
   table in a 15rem track is a table nobody can use. */
.ndn-record-fields > .ndn-record-field--wide {
  grid-column: 1 / -1;
}

.ndn-record-fields .ndn-input-label,
.ndn-record-attachments .ndn-input-label {
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
}

.ndn-record-fields .ndn-input {
  box-sizing: border-box;
  width: 100%;
  min-height: 2.625rem;
  font-size: 0.9375rem;
}

.ndn-record-fields textarea.ndn-input {
  min-height: 6.5rem;
  line-height: 1.55;
  resize: vertical;
}

/* These are hand-written controls, not packages/ui primitives, so they
   carry none of .ndn-interactive's focus styling. Same restatement, and
   same reason, as caseload-styles.ts makes for its own plain controls. */
.ndn-record-fields .ndn-input:focus-visible,
.ndn-record-fields .ndn-checkbox input:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

/* A tick box sits on the baseline of its own label, so it needs the
   field's own vertical rhythm rather than the label-above-control stack. */
.ndn-record-fields > .ndn-record-field--checkbox {
  display: flex;
  align-items: center;
  min-height: 2.625rem;
  margin-block-start: 1.125rem;
}

/* A section's own save button, rendered twice — see AssessmentForm.tsx
   for why. The top copy is a toolbar across the head of the section, ruled
   off from the fields it acts on; the bottom copy is where a form ends and
   needs no rule of its own. Written against .ndn-panel-actions at (0,2,0)
   so it beats that class's own margins wherever Astro puts the two sheets. */
.ndn-panel-actions.ndn-record-actions--top {
  justify-content: flex-end;
  margin-block: 0 1.25rem;
  padding-block-end: 1rem;
  border-block-end: 1px solid var(--ndn-color-border);
}

.ndn-panel-actions.ndn-record-actions--bottom {
  margin-block-start: 1.75rem;
}

/* ------------------------------------------------------------------ *
 * Grids — the paper form's tables, and the appointment list.
 * ------------------------------------------------------------------ */
.ndn-record-table-label {
  margin-block: 1.5rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
}

/* Some grids run to seven columns. A table that cannot scroll inside its
   own box makes the whole page scroll sideways, which on a phone means the
   save button is off screen. */
.ndn-record-scroll {
  overflow-x: auto;
  margin-block: 0 1.5rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.625rem;
  background-color: var(--ndn-color-surface-raised);
}

.ndn-record-table {
  width: 100%;
  border-collapse: collapse;
  text-align: start;
  font-size: 0.875rem;
}

.ndn-record-table caption {
  padding-block: 0.75rem;
  padding-inline: 0.875rem;
  border-block-end: 1px solid var(--ndn-color-border);
  font-family: var(--ndn-font-family-display);
  font-weight: var(--ndn-font-weight-display);
  font-size: 1.125rem;
  text-align: start;
}

.ndn-record-table th {
  padding-block: 0.5rem;
  padding-inline: 0.875rem;
  border-block-end: 1px solid var(--ndn-color-border);
  background-color: var(--ndn-color-surface-muted);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  text-align: start;
  white-space: nowrap;
  color: var(--ndn-color-text-muted);
}

.ndn-record-table td {
  padding-block: 0.5rem;
  padding-inline: 0.875rem;
  border-block-start: 1px solid var(--ndn-color-border);
  vertical-align: middle;
}

.ndn-record-table tbody tr:first-child td {
  border-block-start: 0;
}

.ndn-record-table tbody tr:hover {
  background-color: var(--ndn-color-brand-wash);
}

/* A cell's own box, sized so a row of them reads as a filled-in line
   rather than as a strip of browser defaults. */
.ndn-record-table input:not([type='checkbox']),
.ndn-record-table select {
  box-sizing: border-box;
  width: 100%;
  min-width: 7rem;
  min-height: 2.25rem;
  padding-block: 0.3125rem;
  padding-inline: 0.5rem;
  border: 1px solid var(--ndn-color-border-strong);
  border-radius: 0.375rem;
  background-color: var(--ndn-color-surface-raised);
  color: var(--ndn-color-text);
  font: inherit;
  font-size: 0.875rem;
}

.ndn-record-table input:hover:not(:disabled),
.ndn-record-table select:hover:not(:disabled) {
  border-color: var(--ndn-color-brand);
}

.ndn-record-table input:focus-visible,
.ndn-record-table select:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

/* Two decisions in one cell. Without a flex row they wrap onto separate
   lines whenever the column is narrow, which reads as two unrelated
   controls stacked rather than as the pair of answers to one question. */
.ndn-record-cell-actions {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 0.375rem;
}

/* nowrap above only holds if the pills themselves refuse to break, and a
   table's auto layout will otherwise size the column to the longer word
   rather than to the pair. The scroll container is what absorbs the extra
   width on a narrow screen. */
.ndn-record-cell-actions .ndn-button {
  white-space: nowrap;
}

/* The row a grid appends with, on its own line under the table. */
.ndn-record-row-actions {
  margin-block: 0 1.5rem;
}

/* ------------------------------------------------------------------ *
 * The lead figures — 2026-09-09.
 *
 * *"move 'Next appointment' and 'Next appointment length (minutes)' above
 * the 'My Calender' with slightly bigger font (subtly highlighted) so that
 * that's what the patient sees first before checking the actual calender."*
 *
 * A placement of the calendar section holding those two fields alone, in a
 * wrapper the page writes (account/index.astro). Everything here is a
 * restatement of .ndn-record-facts one step louder — a tinted panel, a
 * brand rule down its leading edge, and an answer at 1.375rem against the
 * 0.9375rem the same pair takes anywhere else on the sheet.
 *
 * "Subtly": the panel is brand-wash, not brand. What makes it the first
 * thing read is the size of the answer and the fact that it is above the
 * calendar, not a colour competing with the area's own heading band.
 * ------------------------------------------------------------------ */
.ndn-record-lead {
  margin-block: 0 1.5rem;
  padding-block: 1rem;
  padding-inline: 1.25rem;
  border-inline-start: 3px solid var(--ndn-color-brand);
  border-radius: 0.5rem;
  background-color: var(--ndn-color-brand-wash);
}

/* The two answers side by side rather than ruled one under the other: two
   figures are a pair to read at a glance, and the ruled list this sheet
   uses elsewhere is for a column of twenty. */
.ndn-record-lead .ndn-record-facts {
  grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
  gap: 0 2rem;
  margin-block: 0;
  border-block-start: 0;
}

.ndn-record-lead .ndn-record-facts dt {
  padding-block: 0 0.125rem;
  padding-inline-end: 0;
  border-block-end: 0;
  font-size: 0.75rem;
  color: var(--ndn-color-brand-strong);
}

.ndn-record-lead .ndn-record-facts dd {
  padding-block: 0;
  border-block-end: 0;
  font-family: var(--ndn-font-family-display);
  font-size: 1.375rem;
  font-weight: 600;
  line-height: 1.3;
  color: var(--ndn-color-text);
}

/* "No appointment is booked yet" sits directly under the empty figure it
   explains, and it is a caption there rather than the boxed aside the same
   class is on the sheet — a panel inside a panel is one border too many. */
.ndn-record-lead .ndn-record-note {
  margin-block: 0.625rem 0;
  padding: 0;
  border: 0;
  background-color: transparent;
  color: var(--ndn-color-brand-strong);
}

/* ------------------------------------------------------------------ *
 * Attachments — the one thing on the sheet that is not a field.
 * ------------------------------------------------------------------ */
.ndn-record-attachments {
  display: block;
  margin-block-start: 2rem;
  padding-block-start: 1.25rem;
  border-block-start: 1px dashed var(--ndn-color-border-strong);
}

.ndn-record-attachments .ndn-heading {
  margin-block-start: 0;
}

/* 2026-09-09: a grid of cards, not a run of pills. A pill held a file
   name; a card holds a preview, the name and the moment it was uploaded,
   which is what the owner asked each file to answer without being opened.
   auto-fill with a 17rem floor, so one file does not stretch to the width
   of the sheet and eight do not become a column. */
.ndn-record-attachment-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr));
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ndn-record-attachment {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding-block: 0.625rem;
  padding-inline: 0.75rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.625rem;
  background-color: var(--ndn-color-surface-muted);
  font-size: 0.875rem;
}

/* Fixed, square and never allowed to shrink: the whole point of the row is
   that the eye runs down a column of previews of one size. It is also what
   reserves the space before a presigned URL has arrived, so a card does not
   jump sideways when its picture lands. */
.ndn-record-attachment-thumb {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  width: 3rem;
  height: 3rem;
  border: 1px solid var(--ndn-color-border);
  border-radius: 0.5rem;
  background-color: var(--ndn-color-surface-raised);
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--ndn-color-text-muted);
}

/* cover, not contain: a preview this small is a texture rather than a
   picture to read, and letterboxing a portrait scan inside 3rem leaves a
   thumbnail two thirds background. */
.ndn-record-attachment-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.ndn-record-attachment-text {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  /* A flex item's default min-width is auto, so a long file name would
     push the button off the card rather than being clipped by it. */
  min-width: 0;
  margin-inline-end: auto;
}

.ndn-record-attachment-name {
  font-weight: 500;
  color: var(--ndn-color-text);
  overflow-wrap: anywhere;
}

.ndn-record-attachment-time {
  font-size: 0.75rem;
  color: var(--ndn-color-text-muted);
  font-variant-numeric: tabular-nums;
}

/* ------------------------------------------------------------------ *
 * "Add a file" — 2026-09-09.
 *
 * *"make the button bootstrapped beautiful (just like other buttons in the
 * theme)."* The control stays a real <input type="file"> and the pill the
 * person clicks is the browser's own ::file-selector-button, styled to
 * match .ndn-button--primary declaration for declaration. It cannot share
 * that class: the element lives in the input's shadow tree, where no class
 * of ours reaches. authoring-styles.ts makes the same trade for the same
 * reason, in the secondary colours its own sheet wants.
 * ------------------------------------------------------------------ */
.ndn-record-file {
  box-sizing: border-box;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: var(--ndn-color-text-muted);
  font: inherit;
  font-size: 0.875rem;
}

.ndn-record-file::file-selector-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 2.25rem;
  margin-inline-end: 0.75rem;
  padding-block: 0.375rem;
  padding-inline: 1.375rem;
  border: 1px solid transparent;
  border-radius: 999px;
  background-color: var(--ndn-color-brand);
  color: var(--ndn-color-surface-raised);
  font-family: var(--ndn-font-family-base);
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.005em;
  cursor: pointer;
  transition: background-color var(--ndn-motion-duration-fast) ease,
    border-color var(--ndn-motion-duration-fast) ease,
    color var(--ndn-motion-duration-fast) ease;
}

.ndn-record-file::file-selector-button:hover {
  background-color: var(--ndn-color-brand-strong);
}

.ndn-record-file:disabled::file-selector-button {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Hand-written control again, so it carries none of .ndn-interactive's
   focus ring — the same restatement .ndn-record-fields makes above. */
.ndn-record-file:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

/* ------------------------------------------------------------------ *
 * Narrow viewports. The sheet keeps its shape; only the margins close up,
 * and the band's negative inline margin has to close with them or the
 * heading hangs off the edge of its own sheet.
 * ------------------------------------------------------------------ */
@media (max-width: 40rem) {
  .ndn-record-area {
    padding-inline: 1rem;
    padding-block-end: 1.25rem;
    border-radius: 0.625rem;
  }

  .ndn-record-area > h2.ndn-heading {
    margin-inline: -1rem;
    padding-inline: 1rem;
    border-start-start-radius: 0.5625rem;
    border-start-end-radius: 0.5625rem;
  }

  /* Label above answer rather than beside it — at this width a 7rem label
     column leaves the answer three words wide. */
  .ndn-record-facts {
    grid-template-columns: minmax(0, 1fr);
  }

  .ndn-record-facts dt {
    padding-block: 0.5rem 0;
    border-block-end: 0;
  }

  .ndn-record-facts dd {
    padding-block: 0 0.5rem;
  }
}
`;
