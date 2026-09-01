// 2026-09-01: the assessment *template* — "Each patient will have an
// assessment form that will be loaded from the template the moment his
// account is being created."
//
// The owner has said the real field list is coming later (*"there will be
// all kinds of info that I will provided later on. However, for now, just
// have something for each section so that it all can be tested"*), so what
// this file commits to is the **shape**, not the questions: a section is a
// `FieldSet`, a field is `{id, label, type}`, and adding the real intake
// form later is editing the arrays below and nothing else. No handler, no
// repository and no page names a field id; they all iterate the template.
//
// It lives in shared-types rather than services/api because the API
// instantiates and validates against it and the web form renders from it —
// one declaration, so a field the API refuses can never be a field the
// form offers.
//
// ## Two field-level rules the section's own matrix row cannot express
//
// A section's matrix row answers "may this role write this section". Two
// fields need an answer narrower than their section's, and both are marked
// on the field rather than enforced by a special case at a call site:
//
//   * **`staffOnly`** — `tag` lives in the general section, and the
//     general section is the one section a *patient* may write. A patient
//     who could set their own tag could tag themselves `IIC` and thereby
//     hand a visitor account a read of their record: the tag is the whole
//     of what narrows a visitor's reach (caseload-repository.ts), so
//     letting the subject of the record choose it would invert the
//     control. A tag is an operational classification the practice
//     assigns, exactly like `account_status` — so the field is writable by
//     everyone who may write the section *except* the patient.
//   * **`derived`** — the calendar's appointment figures are computed from
//     the `APPT#` rows on every read and never stored. Two copies of "when
//     is the next appointment" would be two answers the day one write
//     fails, and the appointment rows are the ones the approval workflow,
//     the clinician calendar and the join-call window already read. A
//     write that names a derived field is refused, not ignored.
import type { FieldSet } from './principal.js';

export type AssessmentFieldType =
  | 'text'
  | 'textarea'
  | 'select'
  | 'date'
  | 'datetime'
  | 'number'
  | 'checkbox';

export interface AssessmentFieldDef {
  readonly id: string;
  readonly label: string;
  readonly type: AssessmentFieldType;
  /** Required for, and only meaningful on, `type: 'select'`. */
  readonly options?: readonly string[];
  /** Writable by every role the section allows *except* the patient — see this file's header. */
  readonly staffOnly?: boolean;
  /** Computed server-side on every read; never stored, and a write naming it is a 400. */
  readonly derived?: boolean;
}

export interface AssessmentSectionDef {
  readonly fieldSet: FieldSet;
  readonly title: string;
  readonly fields: readonly AssessmentFieldDef[];
}

/** The one template every patient's form is instantiated from today. Versioned in its own name so a second template is additive rather than a migration. */
export const ASSESSMENT_TEMPLATE_ID = 'intake-v1';

/** The tag field's own id, and its options. Named here because `Patient.tag` must agree with it — see services/api/src/assessment.ts's tag write-through. */
export const ASSESSMENT_TAG_FIELD_ID = 'tag';
export const ASSESSMENT_TAG_OPTIONS = ['IIC', 'NDN'] as const;

export const ASSESSMENT_TEMPLATE: readonly AssessmentSectionDef[] = [
  {
    fieldSet: 'general',
    title: 'General info',
    fields: [
      {
        id: ASSESSMENT_TAG_FIELD_ID,
        label: 'Programme tag',
        type: 'select',
        options: ASSESSMENT_TAG_OPTIONS,
        staffOnly: true,
      },
      { id: 'preferredName', label: 'Preferred name', type: 'text' },
      { id: 'dateOfBirth', label: 'Date of birth', type: 'date' },
      {
        id: 'preferredContact',
        label: 'Preferred way to be contacted',
        type: 'select',
        options: ['Email', 'Phone', 'WhatsApp'],
      },
      { id: 'emergencyContactName', label: 'Emergency contact name', type: 'text' },
      { id: 'emergencyContactPhone', label: 'Emergency contact phone', type: 'text' },
    ],
  },
  {
    fieldSet: 'patient',
    title: 'Specific to the patient',
    fields: [
      { id: 'presentingConcerns', label: 'What brings you here', type: 'textarea' },
      { id: 'goals', label: 'What you would like to achieve', type: 'textarea' },
      { id: 'medicalHistorySummary', label: 'Relevant medical history', type: 'textarea' },
      { id: 'mobilityAids', label: 'Mobility aids in use', type: 'text' },
      { id: 'consentToRecordSessions', label: 'Happy for sessions to be recorded', type: 'checkbox' },
    ],
  },
  {
    fieldSet: 'private',
    title: 'Specific to the clinician',
    fields: [
      { id: 'clinicianImpression', label: 'Clinical impression', type: 'textarea' },
      { id: 'workingDiagnosis', label: 'Working diagnosis', type: 'text' },
      { id: 'treatmentPlan', label: 'Treatment plan', type: 'textarea' },
      { id: 'riskFlags', label: 'Risk flags', type: 'text' },
    ],
  },
  {
    fieldSet: 'calendar',
    title: 'Calendar',
    fields: [
      { id: 'nextAppointmentAt', label: 'Next appointment', type: 'datetime', derived: true },
      {
        id: 'nextAppointmentDurationMinutes',
        label: 'Next appointment length (minutes)',
        type: 'number',
        derived: true,
      },
      { id: 'sessionsCompleted', label: 'Sessions so far', type: 'number', derived: true },
      {
        id: 'appointmentsAwaitingApproval',
        label: 'Appointments awaiting the principal clinician’s approval',
        type: 'number',
        derived: true,
      },
      { id: 'schedulingNotes', label: 'Scheduling notes', type: 'textarea' },
    ],
  },
];

/** The template's sections, by `FieldSet`. Built once; every lookup below and in services/api goes through it rather than re-scanning the array. */
const SECTIONS_BY_FIELD_SET = new Map<FieldSet, AssessmentSectionDef>(
  ASSESSMENT_TEMPLATE.map((section) => [section.fieldSet, section]),
);

export function templateSection(fieldSet: FieldSet): AssessmentSectionDef | undefined {
  return SECTIONS_BY_FIELD_SET.get(fieldSet);
}

export function templateField(
  fieldSet: FieldSet,
  fieldId: string,
): AssessmentFieldDef | undefined {
  return templateSection(fieldSet)?.fields.find((field) => field.id === fieldId);
}

/**
 * The calendar figures services/api computes on every read. Exported so
 * the API's "you may not write a derived field" check and the web form's
 * "render this read-only" check are the same list, not two lists that
 * agree until one is edited.
 */
export const DERIVED_CALENDAR_FIELDS: readonly string[] = (
  templateSection('calendar')?.fields ?? []
)
  .filter((field) => field.derived)
  .map((field) => field.id);
