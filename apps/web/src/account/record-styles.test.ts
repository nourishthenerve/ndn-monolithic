import { describe, expect, it } from 'vitest';

import { patientRecordStylesCss } from './record-styles.js';

// The same reasoning `caseload-styles.test.ts` and `dashboard-styles.test.ts`
// set out: a stylesheet held as a string can be read as text, and the
// coupling worth checking is between a class a component emits and a rule
// that styles it. Nothing else makes that link — the classes are string
// literals in JSX, so a rename on either side compiles clean and simply
// stops working.

/** Every class this stylesheet exists to style, and where it is written. */
const EMITTED_CLASSES = [
  // patient-record.astro and account/index.astro, on each named area
  'ndn-record-area',
  // AssessmentForm.tsx, PatientRecordPanel.tsx, AppointmentBooking.tsx
  'ndn-record-section',
  'ndn-record-version',
  'ndn-record-note',
  'ndn-record-group',
  'ndn-record-facts',
  'ndn-record-fields',
  'ndn-record-field--wide',
  'ndn-record-field--checkbox',
  'ndn-record-subheading',
  'ndn-record-table-label',
  'ndn-record-scroll',
  'ndn-record-table',
  'ndn-record-row-actions',
  'ndn-record-cell-actions',
  'ndn-record-actions--top',
  'ndn-record-actions--bottom',
  'ndn-record-attachments',
  'ndn-record-attachment-list',
  'ndn-record-backlink',
];

describe('patientRecordStylesCss', () => {
  it('styles every class the record components emit', () => {
    for (const className of EMITTED_CLASSES) {
      expect(patientRecordStylesCss, `no rule for .${className}`).toContain(`.${className}`);
    }
  });

  it('stacks a field label above its control rather than beside it', () => {
    // The whole of the owner's "lying one after the other in a row": a
    // <label> is inline, so an unstyled field put the label and its box on
    // one line. The stack itself is `.ndn-input-wrapper`'s (packages/ui);
    // what this sheet owes is the grid those stacks sit in.
    expect(patientRecordStylesCss).toContain('.ndn-record-fields');
    expect(patientRecordStylesCss).toContain('grid-template-columns: repeat(auto-fit');
  });

  it('gives the four areas three distinct heading voices', () => {
    // "heading, sections, different font size and color and thickness".
    // The area title is the display serif in a band; a group heading is
    // sans caps in the brand colour; a field label is smaller, lighter and
    // muted. A hierarchy that collapses to one size is the thing being
    // fixed, so each of the three is asserted to set its own size.
    for (const selector of [
      '.ndn-record-area > h2.ndn-heading',
      '.ndn-heading.ndn-record-group',
      '.ndn-record-fields .ndn-input-label',
    ]) {
      const rule = patientRecordStylesCss.split(selector)[1] ?? '';
      expect(rule.slice(0, rule.indexOf('}')), `${selector} sets no size`).toContain('font-size');
    }
  });

  it('beats the primitive stylesheet on specificity rather than on order', () => {
    // Astro decides which of two `<style set:html>` elements lands first,
    // so a rule that only wins on source order is a rule that stops
    // winning when something moves. Each of these is a step more specific
    // than the primitive rule it overrides.
    expect(patientRecordStylesCss).toContain('.ndn-record-area > h2.ndn-heading'); // vs h2.ndn-heading
    expect(patientRecordStylesCss).toContain('.ndn-heading.ndn-record-group'); // vs h4.ndn-heading
    expect(patientRecordStylesCss).toContain('.ndn-record-fields .ndn-input-label'); // vs .ndn-input-label
  });

  it('lets a grid scroll inside its own container rather than the page', () => {
    // Some assessment grids run to seven columns; without this the whole
    // page scrolls sideways and the save button goes off screen.
    expect(patientRecordStylesCss).toContain('.ndn-record-scroll');
    expect(patientRecordStylesCss).toContain('overflow-x: auto');
  });

  it('restates a focus outline for its own hand-written controls', () => {
    // They are not `packages/ui` primitives, so they carry none of
    // `.ndn-interactive`'s focus styling — the same restatement, for the
    // same reason, `caseload-styles.ts` makes.
    expect(patientRecordStylesCss).toContain('.ndn-record-fields .ndn-input:focus-visible');
    expect(patientRecordStylesCss).toContain('.ndn-record-table input:focus-visible');
    expect(patientRecordStylesCss).toContain('.ndn-record-table select:focus-visible');
  });

  it('collapses the label column on a narrow viewport', () => {
    // A 7rem label column beside an answer leaves the answer three words
    // wide on a phone.
    expect(patientRecordStylesCss).toContain('@media (max-width: 40rem)');
  });

  it('carries no raw colour — every value comes from tokens/color.ts', () => {
    expect(patientRecordStylesCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(patientRecordStylesCss).not.toMatch(/\brgba?\(/);
  });

  it('carries no backtick, which would end the template literal it lives in', () => {
    expect(patientRecordStylesCss).not.toContain('`');
  });
});
