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
// **2026-09-07: the four sections were renamed.** The owner's rework named
// them "Patient Details", "Patient Assessment Form", "Patient Prescription"
// and "Patient Appointments", and set each one's audience (see
// docs/plan/04-data-model-rbac.md's four `Assessment —` rows, whose cells
// did not have to change — the permissions asked for were already the ones
// implemented). The titles and the section order here are therefore real.
//
// **2026-09-07 (later the same day): "Patient Details" is real too.** The
// owner supplied the intake form itself, as a screenshot of the paper
// original, for the first section — so `general` below is now the programme
// tag plus thirty-two fields transcribed from that form, rather than six
// placeholders, and the promise this
// header opened with held: adding them was editing one array, and no
// handler, repository or page needed a line. Three things did have to move
// with them, and all three are field-level rules described further down:
// `fileNumber` is `staffOnly`, `age` and `bmi` are `derived`, and a
// visitor's reach into this section had to be narrowed by hand
// (`VISITOR_GENERAL_FIELDS` in services/api/src/assessment.ts) because a
// section-level `R` granted over six placeholders is not a decision to
// hand a partner organisation a patient's national ID. See
// docs/runbooks/assessment-forms.md's second 2026-09-07 amendment.
//
// **The other three sections are still placeholders**, and the ones under
// "Patient Prescription" in particular still read as the intake questions
// they were written as. They stay until the owner says what goes in each,
// which is the same standing promise this header opened with.
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
//
// **2026-09-07: both rules gained a second instance, and `derived` gained a
// second *kind*.** `fileNumber` is `staffOnly` alongside `tag`. `age` and
// `bmi` are `derived` alongside the calendar figures — but computed from
// other answers in their own section rather than from `APPT#` rows, so the
// arithmetic is in the form (`AssessmentForm.tsx`) rather than in the API:
// the client already holds every input, and a value recomputed on render is
// a value that cannot be stale. The API's half is unchanged and generic —
// `validateResponses` refuses a write naming any `derived` field in any
// section, which it did before either of these existed.
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
  /**
   * Computed, never stored — and a write naming it is a 400, wherever it is
   * computed. *Where* differs by field and is not expressed here: the
   * calendar's figures come from the API on every read (it has the `APPT#`
   * rows and the client does not), while `age` and `bmi` are worked out by
   * the form from other answers in their own section (it has those, live,
   * before they are saved). See this file's header.
   */
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
    title: 'Patient Details',
    fields: [
      {
        id: ASSESSMENT_TAG_FIELD_ID,
        label: 'Programme tag',
        type: 'select',
        options: ASSESSMENT_TAG_OPTIONS,
        staffOnly: true,
      },
      // Identity.
      { id: 'familyName', label: 'Family name', type: 'text' },
      { id: 'givenNames', label: 'Given name(s)', type: 'text' },
      { id: 'preferredName', label: 'Preferred name', type: 'text' },
      // The practice's own record number, so `staffOnly` for the same
      // reason `tag` is: it is an operational identifier the practice
      // assigns, not something the subject of the record types. The
      // second field-level rule in the system, and the first that is not
      // about authorisation — see this file's header.
      { id: 'fileNumber', label: 'Hospital / MRN / file no.', type: 'text', staffOnly: true },
      { id: 'nationalId', label: 'National ID / NHS no.', type: 'text' },
      { id: 'dateOfBirth', label: 'Date of birth', type: 'date' },
      // Derived, not typed: the form has an "Age: ___ yrs" box, and a
      // stored age is wrong from the patient's next birthday onward. The
      // date of birth above is the fact; this is a view of it, recomputed
      // on every render. See `ageFromDateOfBirth` in `AssessmentForm.tsx`.
      { id: 'age', label: 'Age (years)', type: 'number', derived: true },
      {
        id: 'sexAtBirth',
        label: 'Sex recorded at birth',
        type: 'select',
        options: ['Female', 'Male', 'Intersex', 'Prefer not to say'],
      },
      { id: 'genderIdentity', label: 'Gender identity', type: 'text' },
      { id: 'pronouns', label: 'Pronouns', type: 'text' },
      { id: 'heightCm', label: 'Height (cm)', type: 'number' },
      { id: 'weightKg', label: 'Weight (kg)', type: 'number' },
      // Derived for the same reason as `age`: two stored copies of one
      // fact drift the moment a weight is updated and this is not.
      { id: 'bmi', label: 'BMI (kg/m²)', type: 'number', derived: true },
      {
        id: 'dominantHand',
        label: 'Dominant hand',
        type: 'select',
        options: ['Right', 'Left', 'Ambidextrous'],
      },
      // Contact. The paper form has one "Telephone (home / mobile)" box;
      // two numbers in one string field is a search that cannot work and a
      // number that cannot be dialled, so it is two fields here.
      { id: 'address', label: 'Address', type: 'textarea' },
      { id: 'telephoneHome', label: 'Telephone (home)', type: 'text' },
      { id: 'telephoneMobile', label: 'Telephone (mobile)', type: 'text' },
      { id: 'email', label: 'Email', type: 'text' },
      {
        id: 'preferredContact',
        label: 'Preferred contact',
        type: 'select',
        // The paper form's three boxes exactly. Note this drops WhatsApp,
        // which the previous placeholder offered and which D-29 says the
        // practice actually contacts patients on — flagged rather than
        // quietly re-added, since the screenshot is the instruction.
        options: ['Phone', 'SMS', 'Email'],
      },
      // Language and access needs.
      { id: 'firstLanguage', label: 'First language', type: 'text' },
      { id: 'interpreterRequired', label: 'Interpreter required', type: 'checkbox' },
      { id: 'interpreterLanguage', label: 'Interpreter — language', type: 'text' },
      { id: 'communicationNeeds', label: 'Communication needs', type: 'text' },
      // Next of kin. Replaces the placeholder's emergency-contact pair;
      // stored answers to those two ids survive on existing versions, which
      // is the template-is-not-history rule `assessment.ts` states.
      { id: 'nextOfKinName', label: 'Next of kin / carer', type: 'text' },
      { id: 'nextOfKinRelationship', label: 'Relationship', type: 'text' },
      { id: 'nextOfKinContact', label: 'Contact no.', type: 'text' },
      // Other clinicians involved.
      { id: 'gpPractice', label: 'GP / family physician & practice', type: 'text' },
      { id: 'consultant', label: 'Consultant / specialist', type: 'text' },
      // Funding and billing.
      {
        id: 'funding',
        label: 'Funding',
        type: 'select',
        options: [
          'Public',
          'Private insurance',
          'Self-pay',
          "Workers' comp",
          'MVA / third party',
          'Other',
        ],
      },
      { id: 'fundingOther', label: 'Funding — other', type: 'text' },
      { id: 'insurerPolicyNo', label: 'Insurer / scheme & policy no.', type: 'text' },
      { id: 'claimNumber', label: 'Claim / authorisation no.', type: 'text' },
    ],
  },
  {
    fieldSet: 'private',
    title: 'Patient Assessment Form',
    fields: [
      { id: 'clinicianImpression', label: 'Clinical impression', type: 'textarea' },
      { id: 'workingDiagnosis', label: 'Working diagnosis', type: 'text' },
      { id: 'treatmentPlan', label: 'Treatment plan', type: 'textarea' },
      { id: 'riskFlags', label: 'Risk flags', type: 'text' },
    ],
  },
  {
    fieldSet: 'prescription',
    title: 'Patient Prescription',
    fields: [
      { id: 'presentingConcerns', label: 'What brings you here', type: 'textarea' },
      { id: 'goals', label: 'What you would like to achieve', type: 'textarea' },
      { id: 'medicalHistorySummary', label: 'Relevant medical history', type: 'textarea' },
      { id: 'mobilityAids', label: 'Mobility aids in use', type: 'text' },
      { id: 'consentToRecordSessions', label: 'Happy for sessions to be recorded', type: 'checkbox' },
    ],
  },
  {
    fieldSet: 'calendar',
    title: 'Patient Appointments',
    fields: [
      { id: 'nextAppointmentAt', label: 'Next appointment', type: 'datetime', derived: true },
      {
        id: 'nextAppointmentDurationMinutes',
        label: 'Next appointment length (minutes)',
        type: 'number',
        derived: true,
      },
      /**
       * 2026-09-01: the owner, on the visitor's view — *"i want visitor
       * read only both total number of appointments and next
       * appointment."* Every appointment that stands, by
       * `COUNTED_APPOINTMENT_STATUSES`; distinct from `sessionsCompleted`
       * below, which counts only the ones that actually happened.
       */
      { id: 'totalAppointments', label: 'Appointments in total', type: 'number', derived: true },
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

export function templateField(fieldSet: FieldSet, fieldId: string): AssessmentFieldDef | undefined {
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
