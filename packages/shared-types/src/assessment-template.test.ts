// 2026-09-07. The template is data, and most of it needs no test: a label
// is right or wrong by eye against the owner's form, and nothing computes
// on it. Two things about it are *depended on from another package*, and
// those are what is pinned here.
//
// `apps/web` deliberately does not depend on `@ndn/shared-types` (see
// `AssessmentForm.tsx`'s note above its local type declarations), so the
// form restates the handful of field ids its age and BMI arithmetic names.
// Nothing makes the compiler compare the two copies. This is the half that
// can be checked — if an id here moves, this file fails and says which
// constant in the form to move with it. A drifted id would otherwise be a
// silently blank box on the patient's record.
import { describe, expect, it } from 'vitest';

import {
  ASSESSMENT_TAG_FIELD_ID,
  ASSESSMENT_TEMPLATE,
  DERIVED_CALENDAR_FIELDS,
  templateField,
  templateSection,
} from './assessment-template.js';

/**
 * The general section's two derived fields, and the answers each is
 * computed from. Mirrors the constant block in
 * `apps/web/src/account/AssessmentForm.tsx` — change one, change both.
 */
const IN_SECTION_DERIVED: readonly (readonly [string, readonly string[]])[] = [
  ['age', ['dateOfBirth']],
  ['bmi', ['heightCm', 'weightKg']],
];

describe('the fields AssessmentForm.tsx names by id', () => {
  it.each(IN_SECTION_DERIVED)('ships `%s` in the general section, marked derived', (fieldId) => {
    const field = templateField('general', fieldId);
    expect(field, `general.${fieldId} is gone — AssessmentForm.tsx still names it`).toBeDefined();
    // Not derived means the form would render an editable box beside the
    // one it is computed from, and the API would happily store the typed
    // value — two answers to one question, which is the whole reason
    // these two are not fields a person fills in.
    expect(field?.derived).toBe(true);
  });

  it.each(
    IN_SECTION_DERIVED.flatMap(([fieldId, inputs]) => inputs.map((input) => [fieldId, input])),
  )('%s is computed from `%s`, which the general section still has', (fieldId, input) => {
    const field = templateField('general', input);
    expect(field, `general.${input} is gone — ${fieldId} would render blank forever`).toBeDefined();
    // An input that became derived itself would be arithmetic on
    // arithmetic, which `fieldValue` does not do — it reads inputs
    // straight out of the drafts and the stored answers.
    expect(field?.derived).toBeUndefined();
  });

  it('keeps the tag field, the one id the API also names', () => {
    // `assessment.ts` writes this one through to `Patient.tag`, which is
    // what bounds a visitor's reach. Its own constant already says so; this
    // asserts the template still carries the field that constant points at.
    const tag = templateField('general', ASSESSMENT_TAG_FIELD_ID);
    expect(tag?.staffOnly).toBe(true);
    expect(tag?.options).toContain('IIC');
  });
});

describe('DERIVED_CALENDAR_FIELDS', () => {
  it('is every derived field of the calendar section and nothing from any other', () => {
    // It is built by filtering the calendar section, so the risk it guards
    // is the reverse of a drift: `age` and `bmi` are derived too, and a
    // future refactor that widened this to "every derived field in the
    // template" would quietly add two general-section ids to a list the API
    // uses to decide what a *calendar* read returns.
    expect([...DERIVED_CALENDAR_FIELDS].sort()).toEqual([
      'appointmentsAwaitingApproval',
      'nextAppointmentAt',
      'nextAppointmentDurationMinutes',
      'sessionsCompleted',
      'totalAppointments',
    ]);
  });
});

describe('the template as a whole', () => {
  it('has one section per field set, in the owner’s stated order', () => {
    expect(ASSESSMENT_TEMPLATE.map((section) => section.fieldSet)).toEqual([
      'general',
      'private',
      'prescription',
      'calendar',
    ]);
    expect(ASSESSMENT_TEMPLATE.map((section) => section.title)).toEqual([
      'Patient Details',
      'Patient Assessment Form',
      'Patient Prescription',
      'Patient Appointments',
    ]);
  });

  it('gives every field a unique id within its section', () => {
    // Two fields sharing an id is one box that cannot be written without
    // overwriting the other: `responses` is keyed by id.
    for (const section of ASSESSMENT_TEMPLATE) {
      const ids = section.fields.map((field) => field.id);
      expect(new Set(ids).size, `duplicate field id in ${section.fieldSet}`).toBe(ids.length);
    }
  });

  it('gives options to every select and to nothing else', () => {
    // A select with no options renders an empty dropdown; options on a text
    // field are a list nobody is ever shown.
    for (const section of ASSESSMENT_TEMPLATE) {
      for (const field of section.fields) {
        expect(field.options !== undefined, `${section.fieldSet}.${field.id} (${field.type})`).toBe(
          field.type === 'select',
        );
      }
    }
  });

  it('is reachable by field set through templateSection', () => {
    expect(templateSection('general')?.title).toBe('Patient Details');
    expect(templateSection('calendar')?.title).toBe('Patient Appointments');
  });
});
