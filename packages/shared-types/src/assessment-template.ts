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
// **2026-09-07 (third): "Patient Assessment Form" is real too**, and it is
// the big one — the owner's *Comprehensive Neurorehabilitation and Mental
// Well-Being Assessment*, 15 pages and 45 numbered sections in SOAP order,
// supplied as photographs of the paper original. Section 1 of that document
// is Patient Demographics and is deliberately not transcribed: it is the
// `general` section already, which is what the owner's instruction said.
//
// This one did **not** fit the promise above. Roughly a third of its
// sections are grids — Medication Review is drug × dose × route × frequency
// × indication × started × effects — and a template that could only hold
// scalars had two ways to represent a grid, both bad: one free-text box per
// table, which loses the columns, or seven-times-N numbered fields, which
// loses the reader. So the model grew a third thing after two rewrites that
// grew none: `type: 'rows'` and `AssessmentColumnDef`, and `group` for the
// 44 sub-headings, because six hundred controls under one title is not a
// form. Both are described where they are declared, below.
//
// **"Patient Prescription" is still a placeholder** and still reads as the
// intake questions it was written as. It stays until the owner says what
// goes in it, which is the same standing promise this header opened with.
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
  | 'checkbox'
  /** A grid: named columns, and as many rows as the clinician adds. See `AssessmentColumnDef`. */
  | 'rows';

/**
 * One column of a `type: 'rows'` field.
 *
 * The same shape as a field minus everything that makes no sense per
 * column: a column is not separately derived, not separately staff-only,
 * and cannot itself be a grid — the section's own field carries those
 * answers, and a table inside a table is not something the paper form
 * does. `AssessmentRow` in `assessment.ts` is the value side of this.
 */
export interface AssessmentColumnDef {
  readonly id: string;
  readonly label: string;
  readonly type: Exclude<AssessmentFieldType, 'rows' | 'textarea'>;
  /** Required for, and only meaningful on, `type: 'select'`. */
  readonly options?: readonly string[];
}

export interface AssessmentFieldDef {
  readonly id: string;
  readonly label: string;
  readonly type: AssessmentFieldType;
  /** Required for, and only meaningful on, `type: 'select'`. */
  readonly options?: readonly string[];
  /** Required for, and only meaningful on, `type: 'rows'`. */
  readonly columns?: readonly AssessmentColumnDef[];
  /**
   * The sub-heading this field sits under, rendered once above the first
   * field that names it. **Presentation only** — nothing authorises,
   * validates or filters on a group, which is why it is a string on the
   * field rather than a nesting of the section.
   *
   * That choice is what kept a 45-section clinical form from being a
   * refactor: `section.fields` is still one flat array, so every iterator
   * over it — `validateResponses`, `templateField`, the visitor filter —
   * is untouched by grouping, and the form does the grouping on render.
   */
  readonly group?: string;
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

/**
 * A tick list — the paper form's rows of independent checkboxes, one field
 * each, written one to a line instead of four.
 *
 * **Ids are given explicitly and are never derived from the label.** A
 * clinical record keys its answers by field id, so an id generated from a
 * label would mean a wording change silently orphaning every answer already
 * stored under the old one. Saving that repetition is all this does.
 */
function ticks(
  group: string,
  entries: readonly (readonly [string, string])[],
): readonly AssessmentFieldDef[] {
  return entries.map(([id, label]) => ({ id, label, type: 'checkbox', group }) as const);
}

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
    // 2026-09-07: the owner's *Comprehensive Neurorehabilitation and Mental
    // Well-Being Assessment* — a 15-page, 45-section SOAP document supplied
    // as photographs of the paper original. Sections 2 to 45 are below;
    // section 1, Patient Demographics, is deliberately absent because it is
    // already the `general` section, which is what the owner's instruction
    // said ("Exception Personal Demographics").
    //
    // Roughly thirty of those sections are *grids*, which is why `rows`
    // exists — see this file's header and `AssessmentValue`.
    fields: [

      // The strip above section 1 on every page of the paper form. It is about
      // *this assessment episode* rather than about the patient, which is why it
      // belongs here and not in Patient Details.
      { id: 'assessmentDate', label: 'Assessment date', type: 'date', group: 'Assessment header' },
      { id: 'timeIn', label: 'Time in', type: 'text', group: 'Assessment header' },
      { id: 'timeOut', label: 'Time out', type: 'text', group: 'Assessment header' },
      {
        id: 'episodeVisitNo',
        label: 'Episode / visit no.',
        type: 'text',
        group: 'Assessment header',
      },
      {
        id: 'setting',
        label: 'Setting',
        type: 'select',
        options: ['Outpatient', 'Inpatient', 'Community / home', 'ICU', 'Tele-rehab', 'Other'],
        group: 'Assessment header',
      },
      { id: 'settingOther', label: 'Setting — other', type: 'text', group: 'Assessment header' },
      {
        id: 'assessingPhysiotherapist',
        label: 'Assessing physiotherapist',
        type: 'text',
        group: 'Assessment header',
      },
      {
        id: 'supervisor',
        label: 'Supervisor (if applicable)',
        type: 'text',
        group: 'Assessment header',
      },
      {
        id: 'assessorRegistrationNo',
        label: 'Registration / licence no.',
        type: 'text',
        group: 'Assessment header',
      },
      { id: 'assessorGradeRole', label: 'Grade / role', type: 'text', group: 'Assessment header' },

      // Section 1, Patient Demographics, is deliberately absent: it is already
      // the `general` section ("Patient Details"), and the owner's instruction
      // was to use these pages for the assessment form *except* that one.
      {
        id: 'referralSource',
        label: 'Referral source',
        type: 'select',
        options: ['GP', 'Consultant', 'Emergency dept', 'Ward', 'Self-referral', 'Other'],
        group: '2. Referral details',
      },
      {
        id: 'referralSourceOther',
        label: 'Referral source — other',
        type: 'text',
        group: '2. Referral details',
      },
      {
        id: 'referrerNameDesignation',
        label: 'Referrer name & designation',
        type: 'text',
        group: '2. Referral details',
      },
      { id: 'referralDate', label: 'Referral date', type: 'date', group: '2. Referral details' },
      {
        id: 'referralReceivedDate',
        label: 'Date received',
        type: 'date',
        group: '2. Referral details',
      },
      {
        id: 'referralWaitingDays',
        label: 'Waiting time — referral to assessment (days)',
        type: 'number',
        group: '2. Referral details',
      },
      {
        id: 'referralPriority',
        label: 'Priority',
        type: 'select',
        options: ['Routine', 'Urgent', 'Emergency'],
        group: '2. Referral details',
      },
      {
        id: 'referralReason',
        label: 'Reason for referral / referral question',
        type: 'textarea',
        group: '2. Referral details',
      },
      {
        id: 'referralDiagnosis',
        label: 'Diagnosis stated on referral',
        type: 'textarea',
        group: '2. Referral details',
      },
      ...ticks('2. Referral details', [
        ['documentsImaging', 'Documents received — imaging'],
        ['documentsBloodResults', 'Documents received — blood results'],
        ['documentsOperationNote', 'Documents received — operation note'],
        ['documentsDischargeSummary', 'Documents received — discharge summary'],
        ['documentsPreviousPhysioNotes', 'Documents received — previous physio notes'],
        ['documentsNone', 'Documents received — none'],
      ]),
      {
        id: 'referralPrecautions',
        label: 'Referral precautions / restrictions',
        type: 'textarea',
        group: '2. Referral details',
      },
      {
        id: 'consentToAssessAndTreat',
        label: 'Consent to assess & treat obtained',
        type: 'select',
        options: ['Verbal', 'Written', 'Assent + consultee (capacity)'],
        group: '2. Referral details',
      },
      { id: 'consentDate', label: 'Consent date', type: 'date', group: '2. Referral details' },

      {
        id: 'presentingComplaintOwnWords',
        label: "Patient's own words (“What has brought you here today?”)",
        type: 'textarea',
        group: '3. Presenting complaint',
      },
      {
        id: 'primaryProblemArea',
        label: 'Primary problem area',
        type: 'text',
        group: '3. Presenting complaint',
      },
      {
        id: 'primaryProblemSide',
        label: 'Side',
        type: 'select',
        options: ['Right', 'Left', 'Bilateral', 'Central'],
        group: '3. Presenting complaint',
      },
      {
        id: 'primaryProblemDuration',
        label: 'Duration',
        type: 'text',
        group: '3. Presenting complaint',
      },
      {
        id: 'onsetType',
        label: 'Onset',
        type: 'select',
        options: ['Sudden / traumatic', 'Gradual / insidious', 'Post-operative', 'Post-viral', 'Unknown'],
        group: '3. Presenting complaint',
      },
      { id: 'onsetDate', label: 'Date of onset', type: 'date', group: '3. Presenting complaint' },
      {
        id: 'mechanismOfInjury',
        label: 'Mechanism of injury / precipitating event',
        type: 'textarea',
        group: '3. Presenting complaint',
      },
      {
        id: 'courseSinceOnset',
        label: 'Course since onset',
        type: 'select',
        options: ['Improving', 'Static', 'Worsening', 'Fluctuating', 'Relapsing–remitting'],
        group: '3. Presenting complaint',
      },
      {
        id: 'secondaryComplaints',
        label: 'Secondary complaints (in order of priority)',
        type: 'textarea',
        group: '3. Presenting complaint',
      },

      {
        id: 'historyNarrative',
        label: 'Chronological narrative — onset, evolution, previous episodes, response to treatment',
        type: 'textarea',
        group: '4. History of presenting condition',
      },
      {
        id: 'timelineOfKeyEvents',
        label: 'Timeline of key events',
        type: 'rows',
        group: '4. History of presenting condition',
        columns: [
          { id: 'date', label: 'Date', type: 'date' },
          { id: 'event', label: 'Event / intervention', type: 'text' },
          { id: 'provider', label: 'Provider', type: 'text' },
          { id: 'outcome', label: 'Outcome / response', type: 'text' },
        ],
      },
      {
        id: 'previousTreatments',
        label: 'Previous treatment for this condition',
        type: 'rows',
        group: '4. History of presenting condition',
        columns: [
          {
            id: 'treatment',
            label: 'Treatment (physio, injection, surgery, medication, other)',
            type: 'text',
          },
          { id: 'datesSessions', label: 'Dates / sessions', type: 'text' },
          {
            id: 'effect',
            label: 'Effect',
            type: 'select',
            options: ['Improved', 'No change', 'Worse'],
          },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },
      {
        id: 'investigations',
        label: 'Investigations & results',
        type: 'rows',
        group: '4. History of presenting condition',
        columns: [
          {
            id: 'investigation',
            label: 'Investigation (X-ray, MRI, CT, US, NCS/EMG, bloods, DEXA, other)',
            type: 'text',
          },
          { id: 'date', label: 'Date', type: 'date' },
          { id: 'findings', label: 'Findings', type: 'text' },
          { id: 'seenByClinician', label: 'Seen by clinician', type: 'text' },
        ],
      },
      {
        id: 'previousSimilarEpisodes',
        label: 'Previous similar episodes',
        type: 'checkbox',
        group: '4. History of presenting condition',
      },
      {
        id: 'previousEpisodeCount',
        label: 'Previous episodes — number',
        type: 'number',
        group: '4. History of presenting condition',
      },
      {
        id: 'previousEpisodeMostRecent',
        label: 'Previous episodes — most recent',
        type: 'text',
        group: '4. History of presenting condition',
      },
      {
        id: 'recoveryBetweenEpisodes',
        label: 'Recovery between episodes',
        type: 'select',
        options: ['Full', 'Partial'],
        group: '4. History of presenting condition',
      },

      // A tick list, so one checkbox per condition rather than a multi-select:
      // the paper form's boxes are independent and a clinician ticks as many as
      // apply. `ticks()` keeps each one to a line without deriving any id from a
      // label — a renamed label must never silently orphan a stored answer.
      ...ticks('5. Past medical history', [
        ['pmhHypertension', 'Hypertension'],
        ['pmhIschaemicHeartDisease', 'Ischaemic heart disease'],
        ['pmhHeartFailure', 'Heart failure'],
        ['pmhArrhythmiaAf', 'Arrhythmia / AF'],
        ['pmhStrokeTia', 'Stroke / TIA'],
        ['pmhDiabetes', 'Diabetes (T1 / T2)'],
        ['pmhAsthma', 'Asthma'],
        ['pmhCopd', 'COPD'],
        ['pmhObstructiveSleepApnoea', 'Obstructive sleep apnoea'],
        ['pmhRheumatoidArthritis', 'Rheumatoid arthritis'],
        ['pmhOsteoarthritis', 'Osteoarthritis'],
        ['pmhOsteoporosis', 'Osteoporosis / osteopenia'],
        ['pmhInflammatorySpondyloarthropathy', 'Inflammatory spondyloarthropathy'],
        ['pmhCancer', 'Cancer'],
        ['pmhEpilepsy', 'Epilepsy'],
        ['pmhParkinsons', "Parkinson's disease"],
        ['pmhMultipleSclerosis', 'Multiple sclerosis'],
        ['pmhPeripheralNeuropathy', 'Peripheral neuropathy'],
        ['pmhChronicKidneyDisease', 'Chronic kidney disease'],
        ['pmhLiverDisease', 'Liver disease'],
        ['pmhThyroidDisorder', 'Thyroid disorder'],
        ['pmhAnxietyDepression', 'Anxiety / depression'],
        ['pmhChronicPainSyndrome', 'Chronic pain syndrome'],
        ['pmhFibromyalgia', 'Fibromyalgia'],
        ['pmhDvtPe', 'DVT / PE'],
        ['pmhAnticoagulated', 'Anticoagulated'],
        ['pmhPacemakerIcd', 'Pacemaker / ICD'],
        ['pmhPregnancy', 'Pregnancy'],
        ['pmhRecentInfection', 'Recent infection'],
        ['pmhOther', 'Other'],
      ]),
      {
        id: 'pmhCancerSite',
        label: 'Cancer — site',
        type: 'text',
        group: '5. Past medical history',
      },
      {
        id: 'pmhPregnancyWeeks',
        label: 'Pregnancy — weeks',
        type: 'number',
        group: '5. Past medical history',
      },
      {
        id: 'pmhOtherDetail',
        label: 'Past medical history — other',
        type: 'text',
        group: '5. Past medical history',
      },
      {
        id: 'pmhDetails',
        label: 'Details / dates / current control of the conditions ticked above',
        type: 'textarea',
        group: '5. Past medical history',
      },
      {
        id: 'vaccinationStatus',
        label: 'Vaccination status relevant to care',
        type: 'text',
        group: '5. Past medical history',
      },
      {
        id: 'infectionPrecautions',
        label: 'Infection precautions',
        type: 'select',
        options: ['None', 'Contact', 'Droplet', 'Airborne'],
        group: '5. Past medical history',
      },

      {
        id: 'surgicalHistory',
        label: 'Surgical history',
        type: 'rows',
        group: '6. Surgical history',
        columns: [
          { id: 'procedure', label: 'Procedure', type: 'text' },
          {
            id: 'side',
            label: 'Side',
            type: 'select',
            options: ['Right', 'Left', 'Bilateral', 'N/A'],
          },
          { id: 'date', label: 'Date', type: 'date' },
          { id: 'surgeonHospital', label: 'Surgeon / hospital', type: 'text' },
          { id: 'complications', label: 'Complications / relevance', type: 'text' },
          { id: 'precautionsStillActive', label: 'Precautions still active', type: 'text' },
        ],
      },
      {
        id: 'implantsMetalware',
        label: 'Implants / metalware',
        type: 'checkbox',
        group: '6. Surgical history',
      },
      {
        id: 'implantsMetalwareDetail',
        label: 'Implants / metalware — detail',
        type: 'text',
        group: '6. Surgical history',
      },
      {
        id: 'anaestheticProblems',
        label: 'Anaesthetic problems',
        type: 'checkbox',
        group: '6. Surgical history',
      },
      {
        id: 'anaestheticProblemsDetail',
        label: 'Anaesthetic problems — detail',
        type: 'text',
        group: '6. Surgical history',
      },
      {
        id: 'woundStatus',
        label: 'Wound status',
        type: 'select',
        options: ['N/A', 'Healed', 'Healing', 'Dehiscence', 'Infected'],
        group: '6. Surgical history',
      },
      {
        id: 'woundSuturesClipsOut',
        label: 'Sutures / clips out',
        type: 'text',
        group: '6. Surgical history',
      },

      {
        id: 'medications',
        label: 'Medications',
        type: 'rows',
        group: '7. Medication review',
        columns: [
          { id: 'drug', label: 'Drug (generic)', type: 'text' },
          { id: 'dose', label: 'Dose', type: 'text' },
          { id: 'route', label: 'Route', type: 'text' },
          { id: 'frequency', label: 'Frequency', type: 'text' },
          { id: 'indication', label: 'Indication', type: 'text' },
          { id: 'started', label: 'Started', type: 'date' },
          {
            id: 'physioRelevantEffects',
            label: 'Physio-relevant effects (sedation, ↓BP, bleeding, falls risk)',
            type: 'text',
          },
        ],
      },
      {
        id: 'analgesiaEffectiveness',
        label: 'Analgesia effectiveness',
        type: 'select',
        options: ['Good', 'Partial', 'Poor'],
        group: '7. Medication review',
      },
      {
        id: 'analgesiaTimingRelativeToTherapy',
        label: 'Analgesia — timing relative to therapy',
        type: 'text',
        group: '7. Medication review',
      },
      { id: 'opioidUse', label: 'Opioid use', type: 'checkbox', group: '7. Medication review' },
      {
        id: 'anticoagulantAntiplatelet',
        label: 'Anticoagulant / antiplatelet',
        type: 'checkbox',
        group: '7. Medication review',
      },
      {
        id: 'anticoagulantAgentInr',
        label: 'Anticoagulant — agent & INR',
        type: 'text',
        group: '7. Medication review',
      },
      {
        id: 'corticosteroids',
        label: 'Corticosteroids (oral / injected)',
        type: 'checkbox',
        group: '7. Medication review',
      },
      {
        id: 'corticosteroidsDetail',
        label: 'Corticosteroids — detail',
        type: 'text',
        group: '7. Medication review',
      },
      {
        id: 'bisphosphonatesBoneProtection',
        label: 'Bisphosphonates / bone protection',
        type: 'checkbox',
        group: '7. Medication review',
      },
      {
        id: 'supplementsHerbalOtcRecreational',
        label: 'Supplements, herbal, OTC, recreational drugs',
        type: 'text',
        group: '7. Medication review',
      },
      {
        id: 'adherenceConcerns',
        label: 'Adherence concerns / self-medication pattern',
        type: 'textarea',
        group: '7. Medication review',
      },

      {
        id: 'allergies',
        label: 'Allergies',
        type: 'rows',
        group: '8. Allergies & sensitivities',
        columns: [
          { id: 'allergen', label: 'Allergen / agent', type: 'text' },
          { id: 'type', label: 'Type (drug, food, latex, adhesive, topical, other)', type: 'text' },
          { id: 'reaction', label: 'Reaction', type: 'text' },
          { id: 'severity', label: 'Severity', type: 'text' },
          { id: 'verifiedWith', label: 'Verified with', type: 'text' },
        ],
      },
      {
        id: 'noKnownDrugAllergies',
        label: 'No known drug allergies (NKDA)',
        type: 'checkbox',
        group: '8. Allergies & sensitivities',
      },
      {
        id: 'latexFreePrecautionsRequired',
        label: 'Latex-free precautions required',
        type: 'checkbox',
        group: '8. Allergies & sensitivities',
      },
      {
        id: 'adhesiveTapeSensitivity',
        label: 'Adhesive / tape sensitivity (affects taping, electrodes)',
        type: 'checkbox',
        group: '8. Allergies & sensitivities',
      },

      // Section 9 is four tick lists on the paper form and four groups here, so
      // a clinician reading the screen sees the same four headings they screen
      // against on paper. Every one of them is a checkbox, none is a select: the
      // form's instruction is "tick any present", and a positive finding drives
      // the action field at the end of the section.
      ...ticks('9. Red flags — general / systemic', [
        ['rfUnexplainedWeightLoss', 'Unexplained weight loss (>5% in 1 month)'],
        ['rfFeverChillsNightSweats', 'Fever, chills, night sweats'],
        ['rfMalaiseOutOfProportion', 'Malaise / unwell out of proportion'],
        ['rfNightPainUnrelieved', 'Night pain, unrelieved by position change'],
        ['rfConstantProgressivePain', 'Constant, progressive, non-mechanical pain'],
        ['rfHistoryOfCancer', 'History of cancer'],
        ['rfRecentSignificantInfection', 'Recent significant infection'],
        ['rfImmunosuppression', 'Immunosuppression / long-term steroids'],
        ['rfIvDrugUse', 'IV drug use'],
        ['rfAgeWithNewSymptoms', 'Age <20 or >55 with new symptoms'],
        ['rfUnremittingPain', 'Unremitting pain despite rest & analgesia'],
        ['rfRecentSignificantTrauma', 'Recent significant trauma'],
      ]),

      ...ticks('9. Red flags — spinal & neurological', [
        ['rfSaddleAnaesthesia', 'Saddle anaesthesia'],
        ['rfBladderRetentionIncontinence', 'Bladder retention / incontinence'],
        ['rfFaecalIncontinence', 'Faecal incontinence, loss of anal tone'],
        ['rfBilateralLegPainWeakness', 'Bilateral leg pain / weakness'],
        ['rfProgressiveNeurologicalDeficit', 'Progressive neurological deficit'],
        ['rfGaitAtaxiaMyelopathy', 'Gait ataxia / clumsiness (myelopathy)'],
        ['rfWidespreadSensoryChange', 'Widespread sensory change'],
        ['rfBilateralHandParaesthesia', 'Bilateral hand paraesthesia'],
        ['rfStructuralSpinalDeformity', 'Structural deformity of spine (new)'],
        ['rfThoracicPainNonMechanical', 'Thoracic pain (non-mechanical)'],
        ['rfDropAttacksLoc', 'Drop attacks / loss of consciousness'],
        ['rfSevereHeadacheNewType', 'Severe headache of new type'],
      ]),

      ...ticks('9. Red flags — cervical arterial dysfunction & upper cervical instability (5 Ds & 3 Ns)', [
        ['rfDizzinessVertigo', 'Dizziness / vertigo'],
        ['rfDiplopia', 'Diplopia'],
        ['rfDysarthria', 'Dysarthria'],
        ['rfDysphagia', 'Dysphagia'],
        ['rfCadDropAttacks', 'Drop attacks'],
        ['rfNausea', 'Nausea'],
        ['rfNystagmus', 'Nystagmus'],
        ['rfNumbnessPeriOralFacial', 'Numbness (peri-oral / facial)'],
        ['rfAtaxia', 'Ataxia'],
        ['rfUpperCervicalLaxity', 'Rheumatoid arthritis / Down syndrome (upper cx laxity)'],
        ['rfRecentNeckTraumaManipulation', 'Recent neck trauma / manipulation'],
        ['rfHypertensionVascularRisk', 'Hypertension / vascular risk factors'],
      ]),

      ...ticks('9. Red flags — cardiorespiratory, vascular & other systems', [
        ['rfChestPainOnExertion', 'Chest pain / tightness on exertion'],
        ['rfDyspnoeaAtRest', 'Dyspnoea at rest or minimal exertion'],
        ['rfPalpitationsSyncope', 'Palpitations, syncope, pre-syncope'],
        ['rfCalfPainSwellingDvt', 'Calf pain, unilateral swelling, warmth (DVT)'],
        ['rfHaemoptysisPersistentCough', 'Haemoptysis / new persistent cough'],
        ['rfAbdominalPulsatileMass', 'Abdominal pulsatile mass (AAA)'],
        ['rfClaudicationAbsentPulses', 'Claudication / absent peripheral pulses'],
        ['rfNewOnsetSevereFatigue', 'New-onset severe fatigue'],
        ['rfUnexplainedBruisingBleeding', 'Unexplained bruising / bleeding'],
        ['rfSkinLesionChanging', 'Skin lesion changing in size or colour'],
        ['rfRecentFallOsteoporosis', 'Recent fall with osteoporosis (fracture risk)'],
        ['rfDeterioratingDiabeticFoot', 'Deteriorating diabetic foot / ulcer'],
      ]),

      {
        id: 'redFlagsIdentified',
        label: 'Red flags identified',
        type: 'select',
        options: ['None', 'Yes'],
        group: '9. Red flags — action taken',
      },
      {
        id: 'redFlagsList',
        label: 'Red flags identified — list',
        type: 'textarea',
        group: '9. Red flags — action taken',
      },
      {
        id: 'redFlagAction',
        label: 'Action taken',
        type: 'select',
        options: ['Proceed with assessment', 'Discuss with GP / consultant', 'Urgent same-day referral', 'Emergency (999 / ED)', 'Treatment deferred'],
        group: '9. Red flags — action taken',
      },
      {
        id: 'redFlagPersonContacted',
        label: 'Person contacted',
        type: 'text',
        group: '9. Red flags — action taken',
      },
      {
        id: 'redFlagContactTime',
        label: 'Contact time',
        type: 'text',
        group: '9. Red flags — action taken',
      },
      {
        id: 'redFlagContactOutcome',
        label: 'Outcome / advice given',
        type: 'textarea',
        group: '9. Red flags — action taken',
      },
      {
        id: 'safetyNettingAdviceGiven',
        label: 'Safety-netting advice given to patient (verbal + written)',
        type: 'checkbox',
        group: '9. Red flags — action taken',
      },
      {
        id: 'safetyNettingDetails',
        label: 'Safety-netting advice — details',
        type: 'textarea',
        group: '9. Red flags — action taken',
      },

      {
        id: 'vitalsHeartRateBpm',
        label: 'Heart rate (bpm)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },
      {
        id: 'vitalsBpSystolic',
        label: 'Blood pressure — systolic (mmHg)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },
      {
        id: 'vitalsBpDiastolic',
        label: 'Blood pressure — diastolic (mmHg)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },
      {
        id: 'vitalsRespiratoryRate',
        label: 'Respiratory rate (/min)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },
      {
        id: 'vitalsSpo2Percent',
        label: 'SpO₂ (%)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },
      {
        id: 'vitalsOxygenLitres',
        label: 'On oxygen (L)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },
      {
        id: 'vitalsTemperatureCelsius',
        label: 'Temperature (°C)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },
      {
        id: 'vitalsBloodGlucose',
        label: 'BGL (mmol/L)',
        type: 'number',
        group: '9. Vital signs at assessment',
      },

      {
        id: 'livingArrangement',
        label: 'Living arrangement',
        type: 'select',
        options: ['Alone', 'With partner', 'With family', 'Supported living', 'Residential / nursing care'],
        group: '10. Social history & environment',
      },
      {
        id: 'housingType',
        label: 'Housing type',
        type: 'select',
        options: ['House', 'Flat', 'Bungalow'],
        group: '10. Social history & environment',
      },
      {
        id: 'housingAccess',
        label: 'Access',
        type: 'select',
        options: ['Level', 'Steps', 'Lift', 'Ramp'],
        group: '10. Social history & environment',
      },
      {
        id: 'housingAccessSteps',
        label: 'Access — number of steps',
        type: 'number',
        group: '10. Social history & environment',
      },
      {
        id: 'internalStairs',
        label: 'Internal stairs',
        type: 'checkbox',
        group: '10. Social history & environment',
      },
      {
        id: 'internalStairsFlights',
        label: 'Internal stairs — flights',
        type: 'number',
        group: '10. Social history & environment',
      },
      {
        id: 'internalStairsRails',
        label: 'Internal stairs — rails',
        type: 'select',
        options: ['Left', 'Right', 'Both', 'None'],
        group: '10. Social history & environment',
      },
      {
        id: 'bathroom',
        label: 'Bathroom',
        type: 'select',
        options: ['Upstairs', 'Downstairs', 'Bath', 'Shower', 'Over-bath shower', 'Wet room'],
        group: '10. Social history & environment',
      },
      ...ticks('10. Social history & environment', [
        ['equipmentNone', 'Existing equipment — none'],
        ['equipmentStick', 'Existing equipment — stick'],
        ['equipmentCrutches', 'Existing equipment — crutches'],
        ['equipmentFrame', 'Existing equipment — frame'],
        ['equipmentRollator', 'Existing equipment — rollator'],
        ['equipmentWheelchair', 'Existing equipment — wheelchair'],
        ['equipmentPerchingStool', 'Existing equipment — perching stool'],
        ['equipmentRaisedToiletSeat', 'Existing equipment — raised toilet seat'],
        ['equipmentGrabRails', 'Existing equipment — grab rails'],
        ['equipmentHoist', 'Existing equipment — hoist'],
        ['equipmentOrthosisSplint', 'Existing equipment — orthosis / splint'],
      ]),
      {
        id: 'equipmentOther',
        label: 'Existing equipment — other',
        type: 'text',
        group: '10. Social history & environment',
      },
      {
        id: 'careSupportInPlace',
        label: 'Care / support currently in place (formal & informal, hours per week)',
        type: 'textarea',
        group: '10. Social history & environment',
      },
      {
        id: 'transport',
        label: 'Transport',
        type: 'select',
        options: ['Drives', 'Public transport', 'Lift from family', 'Patient transport'],
        group: '10. Social history & environment',
      },
      {
        id: 'transportImpact',
        label: 'Impact of condition on travel',
        type: 'text',
        group: '10. Social history & environment',
      },

      {
        id: 'currentOccupation',
        label: 'Current occupation / job title',
        type: 'text',
        group: '10. Occupation',
      },
      { id: 'employer', label: 'Employer', type: 'text', group: '10. Occupation' },
      { id: 'yearsInRole', label: 'Years in role', type: 'number', group: '10. Occupation' },
      {
        id: 'workStatus',
        label: 'Work status',
        type: 'select',
        options: ['Working full duties', 'Modified duties', 'Off sick', 'Unemployed', 'Retired', 'Student', 'Carer', 'Volunteer'],
        group: '10. Occupation',
      },
      { id: 'offSickSince', label: 'Off sick since', type: 'date', group: '10. Occupation' },
      {
        id: 'physicalDemands',
        label: 'Physical demands',
        type: 'select',
        options: ['Sedentary', 'Light', 'Moderate', 'Heavy'],
        group: '10. Occupation',
      },
      { id: 'maxLiftKg', label: 'Maximum lift (kg)', type: 'number', group: '10. Occupation' },
      {
        id: 'hoursSeatedPerDay',
        label: 'Hours seated per day',
        type: 'number',
        group: '10. Occupation',
      },
      {
        id: 'hoursStandingPerDay',
        label: 'Hours standing per day',
        type: 'number',
        group: '10. Occupation',
      },
      {
        id: 'keyWorkTasksAffected',
        label: 'Key work tasks affected (repetitive, overhead, driving, VDU, shift work, night shifts)',
        type: 'textarea',
        group: '10. Occupation',
      },
      {
        id: 'ergonomicAssessmentDone',
        label: 'Workplace ergonomic assessment done',
        type: 'checkbox',
        group: '10. Occupation',
      },
      {
        id: 'ergonomicAssessmentDetail',
        label: 'Workplace ergonomic assessment — detail',
        type: 'text',
        group: '10. Occupation',
      },
      {
        id: 'returnToWorkTargetDate',
        label: 'Return-to-work target date',
        type: 'date',
        group: '10. Occupation',
      },

      {
        id: 'fhInflammatoryArthritis',
        label: 'Inflammatory arthritis / autoimmune',
        type: 'text',
        group: '10. Family history',
      },
      {
        id: 'fhCardiovascular',
        label: 'Cardiovascular disease',
        type: 'text',
        group: '10. Family history',
      },
      { id: 'fhDiabetes', label: 'Diabetes', type: 'text', group: '10. Family history' },
      { id: 'fhCancer', label: 'Cancer', type: 'text', group: '10. Family history' },
      {
        id: 'fhOsteoporosisFracture',
        label: 'Osteoporosis / fracture',
        type: 'text',
        group: '10. Family history',
      },
      {
        id: 'fhNeuromuscular',
        label: 'Neurological / neuromuscular',
        type: 'text',
        group: '10. Family history',
      },
      {
        id: 'fhOther',
        label: 'Other relevant family history / genetic conditions',
        type: 'textarea',
        group: '10. Family history',
      },

      {
        id: 'smokingStatus',
        label: 'Smoking',
        type: 'select',
        options: ['Never', 'Ex', 'Current'],
        group: '10. Lifestyle',
      },
      { id: 'smokingQuitYear', label: 'Smoking — quit', type: 'text', group: '10. Lifestyle' },
      {
        id: 'cigarettesPerDay',
        label: 'Cigarettes per day',
        type: 'number',
        group: '10. Lifestyle',
      },
      { id: 'smokingYears', label: 'Smoking — years', type: 'number', group: '10. Lifestyle' },
      { id: 'packYears', label: 'Pack-years', type: 'number', group: '10. Lifestyle' },
      { id: 'vaping', label: 'Vaping', type: 'checkbox', group: '10. Lifestyle' },
      {
        id: 'alcoholUnitsPerWeek',
        label: 'Alcohol (units/week)',
        type: 'number',
        group: '10. Lifestyle',
      },
      {
        id: 'alcoholGuidance',
        label: 'Alcohol',
        type: 'select',
        options: ['Within guidance', 'Above guidance'],
        group: '10. Lifestyle',
      },
      {
        id: 'recreationalDrugUse',
        label: 'Recreational drug use',
        type: 'checkbox',
        group: '10. Lifestyle',
      },
      {
        id: 'recreationalDrugDetail',
        label: 'Recreational drug use — detail',
        type: 'text',
        group: '10. Lifestyle',
      },
      {
        id: 'caffeineDrinksPerDay',
        label: 'Caffeine (drinks/day)',
        type: 'number',
        group: '10. Lifestyle',
      },
      {
        id: 'hydrationLitresPerDay',
        label: 'Hydration (L/day)',
        type: 'number',
        group: '10. Lifestyle',
      },
      { id: 'stressLevel', label: 'Stress level (0–10)', type: 'number', group: '10. Lifestyle' },
      {
        id: 'hobbiesRecreation',
        label: 'Hobbies / recreation',
        type: 'text',
        group: '10. Lifestyle',
      },

      { id: 'usualBedtime', label: 'Usual bedtime', type: 'text', group: '10. Sleep' },
      { id: 'wakeTime', label: 'Wake time', type: 'text', group: '10. Sleep' },
      { id: 'totalSleepHours', label: 'Total sleep (h)', type: 'number', group: '10. Sleep' },
      { id: 'napsPerDay', label: 'Naps per day', type: 'number', group: '10. Sleep' },
      {
        id: 'sleepQuality',
        label: 'Sleep quality',
        type: 'select',
        options: ['Good', 'Fair', 'Poor'],
        group: '10. Sleep',
      },
      {
        id: 'sleepLatency',
        label: 'Latency',
        type: 'select',
        options: ['<30 min', '>30 min'],
        group: '10. Sleep',
      },
      { id: 'nightWakings', label: 'Night wakings per night', type: 'number', group: '10. Sleep' },
      { id: 'nightWakingCause', label: 'Night wakings — cause', type: 'text', group: '10. Sleep' },
      {
        id: 'painRelatedWaking',
        label: 'Pain-related waking',
        type: 'checkbox',
        group: '10. Sleep',
      },
      {
        id: 'painWakingPosition',
        label: 'Pain-related waking — position that wakes',
        type: 'text',
        group: '10. Sleep',
      },
      {
        id: 'sleepingPosition',
        label: 'Sleeping position',
        type: 'select',
        options: ['Supine', 'Prone', 'Side (left)', 'Side (right)', 'Recliner / chair'],
        group: '10. Sleep',
      },
      {
        id: 'mattressPillowSupport',
        label: 'Mattress / pillow support',
        type: 'text',
        group: '10. Sleep',
      },
      {
        id: 'snoringApnoeaWitnessed',
        label: 'Snoring / apnoea witnessed',
        type: 'checkbox',
        group: '10. Sleep',
      },
      {
        id: 'daytimeSleepinessEss',
        label: 'Daytime sleepiness (ESS if done)',
        type: 'number',
        group: '10. Sleep',
      },

      {
        id: 'appetite',
        label: 'Appetite',
        type: 'select',
        options: ['Good', 'Reduced', 'Increased'],
        group: '10. Nutrition',
      },
      { id: 'weightChangeKg', label: 'Weight change (kg)', type: 'number', group: '10. Nutrition' },
      {
        id: 'weightChangeMonths',
        label: 'Weight change — over (months)',
        type: 'number',
        group: '10. Nutrition',
      },
      {
        id: 'weightChangeIntentional',
        label: 'Weight change — intentional',
        type: 'checkbox',
        group: '10. Nutrition',
      },
      { id: 'mealsPerDay', label: 'Meals per day', type: 'number', group: '10. Nutrition' },
      {
        id: 'proteinIntake',
        label: 'Protein intake',
        type: 'select',
        options: ['Adequate', 'Low'],
        group: '10. Nutrition',
      },
      {
        id: 'fruitVegPortionsPerDay',
        label: 'Fruit / veg portions per day',
        type: 'number',
        group: '10. Nutrition',
      },
      { id: 'specialDiet', label: 'Special diet', type: 'text', group: '10. Nutrition' },
      {
        id: 'swallowingDifficulty',
        label: 'Swallowing difficulty (refer SLT)',
        type: 'checkbox',
        group: '10. Nutrition',
      },
      {
        id: 'nutritionalRiskScore',
        label: 'Nutritional risk screen score (e.g. MUST)',
        type: 'number',
        group: '10. Nutrition',
      },
      {
        id: 'dietitianInvolved',
        label: 'Dietitian involved',
        type: 'checkbox',
        group: '10. Nutrition',
      },
      {
        id: 'vitaminDCalciumStatus',
        label: 'Vitamin D / calcium status or supplementation',
        type: 'text',
        group: '10. Nutrition',
      },

      {
        id: 'preMorbidActivityLevel',
        label: 'Pre-morbid activity level',
        type: 'select',
        options: ['Sedentary', 'Lightly active', 'Moderately active', 'Very active', 'Athlete'],
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'moderateMinutesPerWeek',
        label: 'Current activity — moderate (min/week)',
        type: 'number',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'vigorousMinutesPerWeek',
        label: 'Current activity — vigorous (min/week)',
        type: 'number',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'strengthSessionsPerWeek',
        label: 'Strength sessions per week',
        type: 'number',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'sportActivity',
        label: 'Sport / activity',
        type: 'text',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'sportLevel',
        label: 'Level',
        type: 'text',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'sportFrequency',
        label: 'Frequency',
        type: 'text',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'sportPositionRole',
        label: 'Position / role',
        type: 'text',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'stepsPerDay',
        label: 'Steps per day (if tracked)',
        type: 'number',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'sedentaryHoursPerDay',
        label: 'Sedentary time (h/day)',
        type: 'number',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'barriersToActivity',
        label: 'Barriers to activity',
        type: 'textarea',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'previousExerciseAdherence',
        label: 'Previous exercise programme adherence & experience',
        type: 'textarea',
        group: '10. Physical activity & exercise history',
      },
      {
        id: 'exercisePreferences',
        label: 'Exercise preferences (gym, home, group, pool, outdoors, app-based)',
        type: 'text',
        group: '10. Physical activity & exercise history',
      },

      {
        id: 'patientGoals',
        label: 'Patient-stated goals',
        type: 'rows',
        group: '11. Patient goals & expectations',
        columns: [
          { id: 'rank', label: 'Rank', type: 'number' },
          { id: 'goal', label: 'Patient-stated goal', type: 'text' },
          { id: 'currentAbility', label: 'Current ability (0–10)', type: 'number' },
          { id: 'targetAbility', label: 'Target ability (0–10)', type: 'number' },
          { id: 'timeframe', label: 'Timeframe', type: 'text' },
          { id: 'perceivedImportance', label: 'Perceived importance (0–10)', type: 'number' },
        ],
      },
      {
        id: 'patientUnderstandingOfCondition',
        label: "Patient's understanding of their condition",
        type: 'textarea',
        group: '11. Patient goals & expectations',
      },
      {
        id: 'expectationOfPhysiotherapy',
        label: 'Expectation of physiotherapy',
        type: 'textarea',
        group: '11. Patient goals & expectations',
      },
      {
        id: 'beliefsAboutRecovery',
        label: 'Beliefs about recovery',
        type: 'select',
        options: ['Optimistic', 'Uncertain', 'Pessimistic'],
        group: '11. Patient goals & expectations',
      },
      {
        id: 'confidenceToSelfManage',
        label: 'Confidence to self-manage (0–10)',
        type: 'number',
        group: '11. Patient goals & expectations',
      },
      {
        id: 'readinessToChange',
        label: 'Readiness to change',
        type: 'select',
        options: ['Pre-contemplation', 'Contemplation', 'Action'],
        group: '11. Patient goals & expectations',
      },

      // From here the paper form is banded into SOAP phases. The band is folded
      // into the group name rather than made a second level of nesting: one
      // string per field is what keeps `section.fields` flat, and the form reads
      // the band off the part before the ' · '.
      {
        id: 'symptomAreas',
        label: 'Symptom areas',
        type: 'rows',
        group: 'S — Subjective · 12. Symptom behaviour',
        columns: [
          { id: 'area', label: 'Area (P1 / P2 / P3)', type: 'text' },
          { id: 'location', label: 'Location', type: 'text' },
          { id: 'type', label: 'Type', type: 'select', options: ['Constant', 'Intermittent'] },
          { id: 'character', label: 'Character', type: 'text' },
          { id: 'current', label: 'Current (0–10)', type: 'number' },
          { id: 'best', label: 'Best', type: 'number' },
          { id: 'worst', label: 'Worst', type: 'number' },
          { id: 'relationship', label: 'Relationship between areas', type: 'text' },
        ],
      },
      {
        id: 'patternMorning',
        label: '24-hour pattern — morning',
        type: 'text',
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'patternAfternoon',
        label: '24-hour pattern — afternoon',
        type: 'text',
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'patternEvening',
        label: '24-hour pattern — evening',
        type: 'text',
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'patternNight',
        label: '24-hour pattern — night',
        type: 'text',
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'morningStiffnessMinutes',
        label: 'Morning stiffness duration (min)',
        type: 'number',
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'latencyAfterActivity',
        label: 'Latency of symptoms after activity',
        type: 'text',
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'timeToSettle',
        label: 'Time to settle',
        type: 'text',
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'irritability',
        label: 'Irritability',
        type: 'select',
        options: ['Low (settles <5 min)', 'Moderate', 'High (>30 min to settle)'],
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'symptomSeverity',
        label: 'Severity',
        type: 'select',
        options: ['Mild', 'Moderate', 'Severe'],
        group: 'S — Subjective · 12. Symptom behaviour',
      },
      {
        id: 'conditionStage',
        label: 'Stage',
        type: 'select',
        options: ['Acute (<6 wk)', 'Sub-acute (6–12 wk)', 'Chronic (>12 wk)', 'Acute-on-chronic'],
        group: 'S — Subjective · 12. Symptom behaviour',
      },

      {
        id: 'painNowNprs',
        label: 'Pain now (NPRS 0–10)',
        type: 'number',
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'painAveragePastWeek',
        label: 'Average past week (0–10)',
        type: 'number',
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'painWorstPastWeek',
        label: 'Worst past week (0–10)',
        type: 'number',
        group: 'S — Subjective · 13. Pain history',
      },
      ...ticks('S — Subjective · 13. Pain history', [
        ['painSharp', 'Pain descriptor — sharp'],
        ['painDullAching', 'Pain descriptor — dull / aching'],
        ['painThrobbing', 'Pain descriptor — throbbing'],
        ['painBurning', 'Pain descriptor — burning'],
        ['painShootingLancinating', 'Pain descriptor — shooting / lancinating'],
        ['painElectricShock', 'Pain descriptor — electric shock'],
        ['painPinsAndNeedles', 'Pain descriptor — pins and needles'],
        ['painNumb', 'Pain descriptor — numb'],
        ['painCramping', 'Pain descriptor — cramping'],
        ['painStabbing', 'Pain descriptor — stabbing'],
        ['painHeavy', 'Pain descriptor — heavy'],
        ['painTightBandLike', 'Pain descriptor — tight / band-like'],
        ['painDeep', 'Pain descriptor — deep'],
        ['painSuperficial', 'Pain descriptor — superficial'],
        ['painItchingCrawling', 'Pain descriptor — itching / crawling'],
        ['painColdFreezing', 'Pain descriptor — cold / freezing'],
      ]),
      {
        id: 'suspectedPainMechanism',
        label: 'Suspected pain mechanism',
        type: 'select',
        options: ['Nociceptive', 'Peripheral neuropathic', 'Nociplastic / central sensitisation', 'Mixed', 'Referred / visceral'],
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'neuropathicScreenTool',
        label: 'Neuropathic screen (painDETECT / S-LANSS / DN4)',
        type: 'text',
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'neuropathicScreenScore',
        label: 'Neuropathic screen — score',
        type: 'number',
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'neuropathicScreenMax',
        label: 'Neuropathic screen — out of',
        type: 'number',
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'allodynia',
        label: 'Allodynia',
        type: 'checkbox',
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'hyperalgesia',
        label: 'Hyperalgesia',
        type: 'checkbox',
        group: 'S — Subjective · 13. Pain history',
      },
      {
        id: 'analgesiaUsedAndEffect',
        label: 'Analgesia used and effect',
        type: 'textarea',
        group: 'S — Subjective · 13. Pain history',
      },

      // The paper form's three blank body outlines are a *drawing*, and this
      // template has no drawing field — nor should it acquire one for a single
      // use. The section's attachments are the mechanism: a photo or scan of the
      // marked-up chart is filed against this section, and the fields below are
      // the written conclusions the paper form asks for beneath the outlines.
      {
        id: 'bodyChartNotes',
        label: 'Body chart — symptom mapping notes',
        type: 'textarea',
        group: 'S — Subjective · 14. Body chart — symptom mapping',
      },
      {
        id: 'dermatomalPatternSuspected',
        label: 'Dermatomal / peripheral nerve pattern suspected',
        type: 'text',
        group: 'S — Subjective · 14. Body chart — symptom mapping',
      },
      {
        id: 'symptomsCrossMidline',
        label: 'Crosses midline',
        type: 'checkbox',
        group: 'S — Subjective · 14. Body chart — symptom mapping',
      },
      {
        id: 'symptomsBilateral',
        label: 'Bilateral',
        type: 'checkbox',
        group: 'S — Subjective · 14. Body chart — symptom mapping',
      },

      {
        id: 'aggravatingFactors',
        label: 'Aggravating & easing factors',
        type: 'rows',
        group: 'S — Subjective · 15. Aggravating & easing factors',
        columns: [
          { id: 'activity', label: 'Aggravating activity / position', type: 'text' },
          { id: 'timeToOnset', label: 'Time to onset', type: 'text' },
          { id: 'intensity', label: 'Intensity (0–10)', type: 'number' },
          { id: 'timeToEase', label: 'Time to ease', type: 'text' },
          { id: 'easingStrategy', label: 'Easing strategy', type: 'text' },
          { id: 'effectiveness', label: 'Effectiveness', type: 'text' },
        ],
      },
      {
        id: 'effectOfSitting',
        label: 'Effect of sitting',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },
      {
        id: 'effectOfStanding',
        label: 'Effect of standing',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },
      {
        id: 'effectOfWalking',
        label: 'Effect of walking',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },
      {
        id: 'effectOfStairs',
        label: 'Effect of stairs',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },
      {
        id: 'effectOfBending',
        label: 'Effect of bending',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },
      {
        id: 'effectOfLifting',
        label: 'Effect of lifting',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },
      {
        id: 'effectOfCoughingSneezing',
        label: 'Effect of coughing / sneezing',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },
      {
        id: 'effectOfRest',
        label: 'Effect of rest',
        type: 'text',
        group: 'S — Subjective · 15. Aggravating & easing factors',
      },

      {
        id: 'functionalLimitations',
        label: 'Functional limitations',
        type: 'rows',
        group: 'S — Subjective · 16. Functional limitations',
        columns: [
          { id: 'activity', label: 'Activity', type: 'text' },
          {
            id: 'level',
            label: 'Level',
            type: 'select',
            options: ['Independent', 'Aid / adaptation', 'Assist needed', 'Unable'],
          },
          { id: 'aidAdaptation', label: 'Aid / adaptation', type: 'text' },
          { id: 'tolerance', label: 'Tolerance (time / distance / reps)', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },

      ...ticks('S — Subjective · 17. Neurological symptoms', [
        ['nsNumbness', 'Numbness'],
        ['nsParaesthesia', 'Paraesthesia'],
        ['nsWeakness', 'Weakness'],
        ['nsHeavinessOfLimb', 'Heaviness of limb'],
        ['nsClumsinessDroppingObjects', 'Clumsiness / dropping objects'],
        ['nsLossOfDexterity', 'Loss of dexterity (buttons, coins)'],
        ['nsUnsteadinessFalls', 'Unsteadiness / falls'],
        ['nsDizzinessVertigo', 'Dizziness / vertigo'],
        ['nsVisualDisturbance', 'Visual disturbance'],
        ['nsSpeechSwallowingChange', 'Speech / swallowing change'],
        ['nsBladderChange', 'Bladder change'],
        ['nsBowelChange', 'Bowel change'],
        ['nsSexualDysfunction', 'Sexual dysfunction'],
        ['nsSaddleAnaesthesia', 'Saddle anaesthesia'],
        ['nsTemperatureIntolerance', 'Temperature intolerance'],
        ['nsAutonomicSymptoms', 'Autonomic symptoms (sweating, colour change)'],
      ]),
      {
        id: 'nsNumbnessArea',
        label: 'Numbness — area',
        type: 'text',
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'nsParaesthesiaArea',
        label: 'Paraesthesia — area',
        type: 'text',
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'nsWeaknessArea',
        label: 'Weakness — area',
        type: 'text',
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'fallsPast12Months',
        label: 'Falls in past 12 months',
        type: 'number',
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'fallsInjurious',
        label: 'Falls — injurious',
        type: 'number',
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'fearOfFalling',
        label: 'Fear of falling (0–10)',
        type: 'number',
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'lossOfConsciousness',
        label: 'Loss of consciousness',
        type: 'checkbox',
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'neuroProgression',
        label: 'Progression of neurological symptoms',
        type: 'select',
        options: ['Stable', 'Improving', 'Worsening'],
        group: 'S — Subjective · 17. Neurological symptoms',
      },
      {
        id: 'neuroProgressionRate',
        label: 'Progression — rate',
        type: 'text',
        group: 'S — Subjective · 17. Neurological symptoms',
      },

      {
        id: 'psychosocialScreens',
        label: 'Screening tools',
        type: 'rows',
        group: 'S — Subjective · 18. Psychosocial screening',
        columns: [
          { id: 'tool', label: 'Screening tool', type: 'text' },
          { id: 'score', label: 'Score', type: 'text' },
          { id: 'date', label: 'Date', type: 'date' },
          { id: 'interpretation', label: 'Interpretation / cut-off', type: 'text' },
          { id: 'action', label: 'Action', type: 'text' },
        ],
      },
      {
        id: 'moodObserved',
        label: 'Mood observed',
        type: 'select',
        options: ['Euthymic', 'Low', 'Anxious', 'Labile', 'Flat'],
        group: 'S — Subjective · 18. Psychosocial screening',
      },
      {
        id: 'selfHarmRiskScreened',
        label: 'Risk of self-harm screened',
        type: 'select',
        options: ['No concern', 'Concern → escalate'],
        group: 'S — Subjective · 18. Psychosocial screening',
      },
      {
        id: 'copingStrategiesUsed',
        label: 'Coping strategies used',
        type: 'textarea',
        group: 'S — Subjective · 18. Psychosocial screening',
      },
      {
        id: 'socialSupport',
        label: 'Social support',
        type: 'select',
        options: ['Strong', 'Adequate', 'Limited', 'Isolated'],
        group: 'S — Subjective · 18. Psychosocial screening',
      },
      {
        id: 'litigationCompensationOngoing',
        label: 'Litigation / compensation ongoing',
        type: 'checkbox',
        group: 'S — Subjective · 18. Psychosocial screening',
      },

      ...ticks('S — Subjective · 19. Yellow flags — psychological / behavioural', [
        ['yfPainEqualsHarm', 'Belief that pain equals harm'],
        ['yfCatastrophicThinking', 'Catastrophic thinking'],
        ['yfFearAvoidanceOfMovement', 'Fear-avoidance of movement'],
        ['yfExpectationOfPassiveTreatment', 'Expectation of passive treatment only'],
        ['yfLowSelfEfficacy', 'Low self-efficacy / helplessness'],
        ['yfLowMoodWithdrawal', 'Low mood, withdrawal'],
        ['yfHealthAnxietyHypervigilance', 'Health anxiety / hypervigilance'],
        ['yfPoorPreviousTreatmentExperience', 'Poor previous treatment experience'],
        ['yfOverRelianceOnMedication', 'Over-reliance on medication'],
        ['yfSleepDisturbanceFromWorry', 'Sleep disturbance driven by worry'],
        ['yfPerceivedPoorPrognosis', 'Perceived poor prognosis'],
        ['yfAvoidanceOfWorkSocialRoles', 'Avoidance of work or social roles'],
      ]),

      ...ticks('S — Subjective · 19. Blue flags — workplace perceptions', [
        ['bfWorkIsHarmful', 'Believes work is harmful'],
        ['bfLowJobSatisfaction', 'Low job satisfaction'],
        ['bfUnsupportiveManager', 'Unsupportive manager / colleagues'],
        ['bfNoModifiedDutiesBelief', 'Belief of no modified duties available'],
        ['bfHighDemandLowControl', 'High perceived job demand, low control'],
        ['bfFearOfReInjuryAtWork', 'Fear of re-injury at work'],
        ['bfPoorReturnToWorkExpectation', 'Poor expectation of return to work'],
        ['bfConflictAtWorkBullying', 'Conflict at work / bullying'],
        ['bfJobInsecurity', 'Job insecurity'],
      ]),

      ...ticks('S — Subjective · 19. Black flags — system, contextual & occupational obstacles', [
        ['kfCompensationInsuranceDispute', 'Compensation / insurance dispute'],
        ['kfLitigationInProgress', 'Litigation in progress'],
        ['kfSicknessBenefitsDisincentive', 'Sickness benefits disincentive'],
        ['kfEmployerPolicyBlocksGradedReturn', 'Employer policy blocks graded return'],
        ['kfNoLightDutiesAvailable', 'No light duties genuinely available'],
        ['kfLongWaitingList', 'Long waiting list for intervention'],
        ['kfConflictingClinicianAdvice', 'Conflicting advice from clinicians'],
        ['kfFinancialHardship', 'Financial hardship'],
        ['kfTransportAccessDifficulty', 'Transport / access difficulty'],
        ['kfCaringResponsibilities', 'Caring responsibilities limit attendance'],
        ['kfHousingUnsuitableForRehab', 'Housing unsuitable for rehab'],
        ['kfLanguageLiteracyBarrier', 'Language / literacy barrier'],
      ]),

      ...ticks('S — Subjective · 19. Orange flags — psychiatric symptoms requiring specialist referral', [
        ['ofMajorDepressiveDisorder', 'Major depressive disorder'],
        ['ofSuicidalIdeationSelfHarm', 'Suicidal ideation / self-harm'],
        ['ofPsychosisDelusionalBeliefs', 'Psychosis / delusional beliefs'],
        ['ofPtsdSymptoms', 'PTSD symptoms'],
        ['ofSeverePersonalityDisorder', 'Severe personality disorder'],
        ['ofSubstanceAlcoholDependence', 'Substance / alcohol dependence'],
        ['ofEatingDisorder', 'Eating disorder'],
        ['ofExistingMentalHealthTeam', 'Existing mental-health team involvement'],
      ]),
      {
        id: 'flagsSummary',
        label: 'Summary of flags identified',
        type: 'textarea',
        group: 'S — Subjective · 19. Orange flags — psychiatric symptoms requiring specialist referral',
      },
      {
        id: 'flagsImpactOnPrognosis',
        label: 'Impact on prognosis and plan',
        type: 'textarea',
        group: 'S — Subjective · 19. Orange flags — psychiatric symptoms requiring specialist referral',
      },
      {
        id: 'flagsReferralRequired',
        label: 'Referral / escalation required',
        type: 'checkbox',
        group: 'S — Subjective · 19. Orange flags — psychiatric symptoms requiring specialist referral',
      },
      {
        id: 'flagsReferralTo',
        label: 'Referral / escalation — to',
        type: 'text',
        group: 'S — Subjective · 19. Orange flags — psychiatric symptoms requiring specialist referral',
      },
      {
        id: 'flagsReferralDate',
        label: 'Referral / escalation — date',
        type: 'date',
        group: 'S — Subjective · 19. Orange flags — psychiatric symptoms requiring specialist referral',
      },

      {
        id: 'generalAppearance',
        label: 'General appearance',
        type: 'select',
        options: ['Well', 'Unwell', 'In distress', 'Fatigued', 'Cachectic', 'Obese'],
        group: 'O — Objective · 20. Observation',
      },
      ...ticks('O — Objective · 20. Observation', [
        ['devicesNone', 'Attachments / devices — none'],
        ['devicesOxygen', 'Attachments / devices — O₂'],
        ['devicesIv', 'Attachments / devices — IV'],
        ['devicesCatheter', 'Attachments / devices — catheter'],
        ['devicesDrain', 'Attachments / devices — drain'],
        ['devicesCastBrace', 'Attachments / devices — cast / brace'],
        ['devicesMonitoring', 'Attachments / devices — monitoring'],
      ]),
      {
        id: 'devicesOther',
        label: 'Attachments / devices — other',
        type: 'text',
        group: 'O — Objective · 20. Observation',
      },
      ...ticks('O — Objective · 20. Observation', [
        ['skinIntact', 'Skin — intact'],
        ['skinScar', 'Skin — scar'],
        ['skinBruising', 'Skin — bruising'],
        ['skinErythema', 'Skin — erythema'],
        ['skinSwelling', 'Skin — swelling'],
        ['skinTrophicChanges', 'Skin — trophic changes'],
        ['skinWound', 'Skin — wound'],
      ]),
      {
        id: 'skinWoundSite',
        label: 'Skin — wound site',
        type: 'text',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'swellingSite',
        label: 'Swelling / effusion — site',
        type: 'text',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'swellingGirthLeftCm',
        label: 'Swelling — girth left (cm)',
        type: 'number',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'swellingGirthRightCm',
        label: 'Swelling — girth right (cm)',
        type: 'number',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'swellingGirthLandmark',
        label: 'Swelling — girth landmark',
        type: 'text',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'muscleBulk',
        label: 'Muscle bulk',
        type: 'select',
        options: ['Symmetrical', 'Wasting'],
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'muscleWastingSite',
        label: 'Muscle wasting — site',
        type: 'text',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'muscleBulkGirthLeftCm',
        label: 'Muscle bulk — girth left (cm)',
        type: 'number',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'muscleBulkGirthRightCm',
        label: 'Muscle bulk — girth right (cm)',
        type: 'number',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'willingnessToMove',
        label: 'Willingness to move / pain behaviour',
        type: 'textarea',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'assistiveDeviceOnArrival',
        label: 'Assistive device in use on arrival',
        type: 'text',
        group: 'O — Objective · 20. Observation',
      },
      {
        id: 'footwearAppropriateness',
        label: 'Footwear appropriateness',
        type: 'text',
        group: 'O — Objective · 20. Observation',
      },

      {
        id: 'postureFindings',
        label: 'Posture by view',
        type: 'rows',
        group: 'O — Objective · 21. Posture',
        columns: [
          {
            id: 'view',
            label: 'View',
            type: 'select',
            options: ['Anterior', 'Posterior', 'Lateral (left)', 'Lateral (right)', 'Sitting'],
          },
          { id: 'headCervical', label: 'Head / cervical', type: 'text' },
          { id: 'shoulderGirdle', label: 'Shoulder girdle', type: 'text' },
          { id: 'thoracicRibCage', label: 'Thoracic / rib cage', type: 'text' },
          { id: 'lumboPelvic', label: 'Lumbo-pelvic', type: 'text' },
          { id: 'lowerLimbFoot', label: 'Lower limb / foot', type: 'text' },
        ],
      },
      {
        id: 'posturalType',
        label: 'Postural type',
        type: 'select',
        options: ['Neutral', 'Kyphotic-lordotic', 'Flat back', 'Sway back', 'Scoliotic'],
        group: 'O — Objective · 21. Posture',
      },
      {
        id: 'scoliosisConvexity',
        label: 'Scoliosis — convexity',
        type: 'text',
        group: 'O — Objective · 21. Posture',
      },
      {
        id: 'legLengthTrueLeftCm',
        label: 'Leg length — true, left (cm)',
        type: 'number',
        group: 'O — Objective · 21. Posture',
      },
      {
        id: 'legLengthTrueRightCm',
        label: 'Leg length — true, right (cm)',
        type: 'number',
        group: 'O — Objective · 21. Posture',
      },
      {
        id: 'legLengthApparentLeftCm',
        label: 'Leg length — apparent, left (cm)',
        type: 'number',
        group: 'O — Objective · 21. Posture',
      },
      {
        id: 'legLengthApparentRightCm',
        label: 'Leg length — apparent, right (cm)',
        type: 'number',
        group: 'O — Objective · 21. Posture',
      },
      {
        id: 'postureCorrectionAltersSymptoms',
        label: 'Correction of posture alters symptoms',
        type: 'checkbox',
        group: 'O — Objective · 21. Posture',
      },
      {
        id: 'postureCorrectionHow',
        label: 'Correction of posture — how',
        type: 'text',
        group: 'O — Objective · 21. Posture',
      },

      {
        id: 'gaitAidUsed',
        label: 'Aid used',
        type: 'select',
        options: ['None', '1 stick', '2 sticks', 'Crutches', 'Frame', 'Rollator', 'Orthosis', 'Wheelchair'],
        group: 'O — Objective · 22. Gait analysis',
      },
      {
        id: 'weightBearingStatus',
        label: 'Weight-bearing status',
        type: 'select',
        options: ['NWB', 'TTWB', 'PWB', 'WBAT', 'FWB'],
        group: 'O — Objective · 22. Gait analysis',
      },
      {
        id: 'partialWeightBearingPercent',
        label: 'Partial weight-bearing (%)',
        type: 'number',
        group: 'O — Objective · 22. Gait analysis',
      },
      {
        id: 'gaitSupervision',
        label: 'Supervision',
        type: 'select',
        options: ['Independent', 'Supervision', 'Assist'],
        group: 'O — Objective · 22. Gait analysis',
      },
      {
        id: 'gaitAssistNumber',
        label: 'Assist — number of people',
        type: 'number',
        group: 'O — Objective · 22. Gait analysis',
      },
      {
        id: 'gaitParameters',
        label: 'Gait parameters',
        type: 'rows',
        group: 'O — Objective · 22. Gait analysis',
        columns: [
          { id: 'parameter', label: 'Gait parameter', type: 'text' },
          { id: 'finding', label: 'Finding', type: 'text' },
        ],
      },
      {
        id: 'gaitPhaseDeviations',
        label: 'Deviations by gait phase',
        type: 'rows',
        group: 'O — Objective · 22. Gait analysis',
        columns: [
          { id: 'phase', label: 'Gait phase', type: 'text' },
          { id: 'deviationLeft', label: 'Deviation observed (left)', type: 'text' },
          { id: 'deviationRight', label: 'Deviation observed (right)', type: 'text' },
        ],
      },
      ...ticks('O — Objective · 22. Gait analysis', [
        ['gaitAntalgic', 'Named gait pattern — antalgic'],
        ['gaitTrendelenburg', 'Named gait pattern — Trendelenburg'],
        ['gaitSteppageFootDrop', 'Named gait pattern — steppage / foot-drop'],
        ['gaitAtaxic', 'Named gait pattern — ataxic'],
        ['gaitHemiplegic', 'Named gait pattern — hemiplegic'],
        ['gaitSpasticDiplegic', 'Named gait pattern — spastic diplegic'],
        ['gaitParkinsonianFestinant', 'Named gait pattern — Parkinsonian / festinant'],
        ['gaitWaddling', 'Named gait pattern — waddling'],
        ['gaitVaulting', 'Named gait pattern — vaulting'],
        ['gaitCircumduction', 'Named gait pattern — circumduction'],
      ]),

      {
        id: 'cranialNerves',
        label: 'Cranial nerves',
        type: 'rows',
        group: 'O — Objective · 23. Cranial nerve examination',
        columns: [
          { id: 'cn', label: 'CN', type: 'text' },
          { id: 'nerve', label: 'Nerve', type: 'text' },
          { id: 'testPerformed', label: 'Test performed', type: 'text' },
          { id: 'right', label: 'Right', type: 'text' },
          { id: 'left', label: 'Left', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },

      {
        id: 'levelOfConsciousness',
        label: 'Level of consciousness',
        type: 'select',
        options: ['Alert', 'Drowsy', 'Confused'],
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'gcsTotal',
        label: 'GCS total (/15)',
        type: 'number',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'gcsEye',
        label: 'GCS — eye',
        type: 'number',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'gcsVerbal',
        label: 'GCS — verbal',
        type: 'number',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'gcsMotor',
        label: 'GCS — motor',
        type: 'number',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'orientationTime',
        label: 'Orientation — time',
        type: 'checkbox',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'orientationPlace',
        label: 'Orientation — place',
        type: 'checkbox',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'orientationPerson',
        label: 'Orientation — person',
        type: 'checkbox',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'attentionConcentration',
        label: 'Attention / concentration',
        type: 'text',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'insightIntoDeficits',
        label: 'Insight into deficits',
        type: 'text',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'memoryImmediate',
        label: 'Memory — immediate',
        type: 'text',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'memoryShortTerm',
        label: 'Memory — short-term',
        type: 'text',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'memoryLongTerm',
        label: 'Memory — long-term',
        type: 'text',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'speechLanguage',
        label: 'Speech / language',
        type: 'select',
        options: ['Normal', 'Dysarthria', 'Expressive dysphasia', 'Receptive dysphasia', 'Apraxia of speech'],
        group: 'O — Objective · 24. Higher mental functions',
      },
      ...ticks('O — Objective · 24. Higher mental functions', [
        ['perceptionNeglect', 'Perception — neglect'],
        ['perceptionAgnosia', 'Perception — agnosia'],
        ['perceptionApraxia', 'Perception — apraxia'],
        ['perceptionVisuospatialDeficit', 'Perception — visuospatial deficit'],
        ['perceptionBodySchemeDisorder', 'Perception — body-scheme disorder'],
      ]),
      {
        id: 'perceptionNeglectSide',
        label: 'Perception — neglect side',
        type: 'select',
        options: ['Left', 'Right'],
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'executiveFunction',
        label: 'Executive function / problem solving / safety awareness',
        type: 'textarea',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'cognitiveScreenUsed',
        label: 'Cognitive screen used',
        type: 'select',
        options: ['MMSE', 'MoCA', 'SLUMS', 'AMTS', 'Other'],
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'cognitiveScreenScore',
        label: 'Cognitive screen — score',
        type: 'number',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'cognitiveScreenOther',
        label: 'Cognitive screen — other',
        type: 'text',
        group: 'O — Objective · 24. Higher mental functions',
      },
      {
        id: 'behaviourCooperationFatigue',
        label: 'Behaviour / cooperation / fatigue during testing',
        type: 'textarea',
        group: 'O — Objective · 24. Higher mental functions',
      },

      {
        id: 'muscleTone',
        label: 'Muscle tone by region',
        type: 'rows',
        group: 'O — Objective · 25. Muscle tone',
        columns: [
          { id: 'region', label: 'Region', type: 'text' },
          {
            id: 'tone',
            label: 'Tone',
            type: 'select',
            options: ['Normal', 'Hypotonic', 'Hypertonic'],
          },
          { id: 'masRight', label: 'Modified Ashworth right (0–4)', type: 'text' },
          { id: 'masLeft', label: 'Modified Ashworth left (0–4)', type: 'text' },
          { id: 'clonusBeats', label: 'Clonus (beats)', type: 'number' },
          { id: 'spasmFrequencyPenn', label: 'Spasm frequency (Penn 0–4)', type: 'number' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },

      // Three grids rather than one: the paper form's spine table has a single
      // AROM/PROM pair per movement while the limb tables have a left and a
      // right of each, and one table with six mostly-empty columns would be a
      // worse record than three that match the page.
      {
        id: 'romInstrument',
        label: 'Instrument',
        type: 'select',
        options: ['Goniometer', 'Inclinometer', 'Tape', 'Visual estimate'],
        group: 'O — Objective · 26. Range of motion',
      },
      {
        id: 'romSpine',
        label: 'Range of motion — spine',
        type: 'rows',
        group: 'O — Objective · 26. Range of motion',
        columns: [
          { id: 'movement', label: 'Region / movement', type: 'text' },
          { id: 'arom', label: 'AROM', type: 'text' },
          { id: 'pain', label: 'Pain (0–10)', type: 'number' },
          { id: 'prom', label: 'PROM', type: 'text' },
          { id: 'endFeel', label: 'End-feel', type: 'text' },
          { id: 'comments', label: 'Comments / over-pressure', type: 'text' },
        ],
      },
      {
        id: 'romUpperLimb',
        label: 'Range of motion — upper limb',
        type: 'rows',
        group: 'O — Objective · 26. Range of motion',
        columns: [
          { id: 'movement', label: 'Joint / movement', type: 'text' },
          { id: 'rightArom', label: 'R AROM', type: 'text' },
          { id: 'rightProm', label: 'R PROM', type: 'text' },
          { id: 'leftArom', label: 'L AROM', type: 'text' },
          { id: 'leftProm', label: 'L PROM', type: 'text' },
          { id: 'endFeelPain', label: 'End-feel / pain', type: 'text' },
        ],
      },
      {
        id: 'romLowerLimb',
        label: 'Range of motion — lower limb',
        type: 'rows',
        group: 'O — Objective · 26. Range of motion',
        columns: [
          { id: 'movement', label: 'Joint / movement', type: 'text' },
          { id: 'rightArom', label: 'R AROM', type: 'text' },
          { id: 'rightProm', label: 'R PROM', type: 'text' },
          { id: 'leftArom', label: 'L AROM', type: 'text' },
          { id: 'leftProm', label: 'L PROM', type: 'text' },
          { id: 'endFeelPain', label: 'End-feel / pain', type: 'text' },
        ],
      },
      {
        id: 'capsularPatternPresent',
        label: 'Capsular pattern present',
        type: 'checkbox',
        group: 'O — Objective · 26. Range of motion',
      },
      {
        id: 'capsularPatternJoint',
        label: 'Capsular pattern — joint',
        type: 'text',
        group: 'O — Objective · 26. Range of motion',
      },
      {
        id: 'muscleLengthTests',
        label: 'Muscle length tests (Thomas, Ober, 90/90, Ely, calf)',
        type: 'textarea',
        group: 'O — Objective · 26. Range of motion',
      },

      {
        id: 'mmtUpperLimb',
        label: 'Upper limb myotomes & muscle groups',
        type: 'rows',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
        columns: [
          { id: 'myotome', label: 'Myotome / muscle group', type: 'text' },
          { id: 'actionTested', label: 'Action tested', type: 'text' },
          { id: 'right', label: 'R', type: 'text' },
          { id: 'left', label: 'L', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },
      {
        id: 'mmtLowerLimbTrunk',
        label: 'Lower limb & trunk myotomes',
        type: 'rows',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
        columns: [
          { id: 'myotome', label: 'Myotome / muscle group', type: 'text' },
          { id: 'actionTested', label: 'Action tested', type: 'text' },
          { id: 'right', label: 'R', type: 'text' },
          { id: 'left', label: 'L', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },
      {
        id: 'gripDynamometerRightKg',
        label: 'Grip dynamometer — right (kg)',
        type: 'number',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
      },
      {
        id: 'gripDynamometerLeftKg',
        label: 'Grip dynamometer — left (kg)',
        type: 'number',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
      },
      {
        id: 'pinchDynamometerRightKg',
        label: 'Pinch dynamometer — right (kg)',
        type: 'number',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
      },
      {
        id: 'pinchDynamometerLeftKg',
        label: 'Pinch dynamometer — left (kg)',
        type: 'number',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
      },
      {
        id: 'repeatedHeelRaises',
        label: 'Repeated heel raises / calf raise test',
        type: 'text',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
      },
      {
        id: 'sitToStandFiveSeconds',
        label: 'Sit-to-stand × 5 (s)',
        type: 'number',
        group: 'O — Objective · 27. Manual muscle testing (Oxford / MRC 0–5)',
      },

      {
        id: 'deepTendonReflexes',
        label: 'Deep tendon reflexes',
        type: 'rows',
        group: 'O — Objective · 28. Reflexes',
        columns: [
          { id: 'reflex', label: 'Deep tendon reflex', type: 'text' },
          { id: 'root', label: 'Root', type: 'text' },
          { id: 'right', label: 'R (0–4+)', type: 'text' },
          { id: 'left', label: 'L (0–4+)', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },
      {
        id: 'pathologicalReflexes',
        label: 'Pathological / superficial reflexes',
        type: 'rows',
        group: 'O — Objective · 28. Reflexes',
        columns: [
          { id: 'reflex', label: 'Pathological / superficial reflex', type: 'text' },
          { id: 'right', label: 'R', type: 'text' },
          { id: 'left', label: 'L', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },
      {
        id: 'reflexReinforcementUsed',
        label: 'Reinforcement (Jendrassik) used',
        type: 'checkbox',
        group: 'O — Objective · 28. Reflexes',
      },
      {
        id: 'neurodynamicUlnt',
        label: 'Neurodynamic tests — ULNT 1 / 2a / 2b / 3',
        type: 'text',
        group: 'O — Objective · 28. Reflexes',
      },
      {
        id: 'slrRightDegrees',
        label: 'SLR right (°)',
        type: 'number',
        group: 'O — Objective · 28. Reflexes',
      },
      {
        id: 'slrLeftDegrees',
        label: 'SLR left (°)',
        type: 'number',
        group: 'O — Objective · 28. Reflexes',
      },
      { id: 'slumpTest', label: 'Slump', type: 'text', group: 'O — Objective · 28. Reflexes' },
      {
        id: 'proneKneeBendTest',
        label: 'PKB',
        type: 'text',
        group: 'O — Objective · 28. Reflexes',
      },

      {
        id: 'sensoryExamination',
        label: 'Sensory modalities',
        type: 'rows',
        group: 'O — Objective · 29. Sensory examination',
        columns: [
          { id: 'modality', label: 'Modality', type: 'text' },
          { id: 'method', label: 'Method', type: 'text' },
          { id: 'rightAreaFinding', label: 'Right — area & finding', type: 'text' },
          { id: 'leftAreaFinding', label: 'Left — area & finding', type: 'text' },
          {
            id: 'pattern',
            label: 'Pattern (dermatomal / peripheral / glove-stocking)',
            type: 'text',
          },
        ],
      },
      ...ticks('O — Objective · 29. Sensory examination', [
        ['dermatomesC2T1', 'Dermatomes tested — C2–T1'],
        ['dermatomesT2T12', 'Dermatomes tested — T2–T12'],
        ['dermatomesL1S2', 'Dermatomes tested — L1–S2'],
        ['dermatomesS3S5', 'Dermatomes tested — S3–S5'],
      ]),
      {
        id: 'sensoryAbnormalLevels',
        label: 'Abnormal levels',
        type: 'text',
        group: 'O — Objective · 29. Sensory examination',
      },
      {
        id: 'monofilamentSitesFailed',
        label: 'Monofilament (10 g) sites failed',
        type: 'text',
        group: 'O — Objective · 29. Sensory examination',
      },

      {
        id: 'coordinationTests',
        label: 'Coordination tests',
        type: 'rows',
        group: 'O — Objective · 30. Coordination',
        columns: [
          { id: 'test', label: 'Test', type: 'text' },
          { id: 'right', label: 'Right', type: 'text' },
          { id: 'left', label: 'Left', type: 'text' },
          {
            id: 'findings',
            label: 'Findings (dysmetria, intention tremor, dysdiadochokinesia, decomposition)',
            type: 'text',
          },
        ],
      },

      {
        id: 'balanceTasks',
        label: 'Balance tasks',
        type: 'rows',
        group: 'O — Objective · 31. Balance',
        columns: [
          { id: 'task', label: 'Balance task', type: 'text' },
          { id: 'resultTime', label: 'Result / time', type: 'text' },
          { id: 'levelOfAssistance', label: 'Level of assistance', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },
      {
        id: 'balanceStrategyUsed',
        label: 'Strategy used',
        type: 'select',
        options: ['Ankle', 'Hip', 'Stepping'],
        group: 'O — Objective · 31. Balance',
      },
      {
        id: 'fallsRisk',
        label: 'Falls risk',
        type: 'select',
        options: ['Low', 'Moderate', 'High'],
        group: 'O — Objective · 31. Balance',
      },
      {
        id: 'balanceSupervisionRequired',
        label: 'Supervision required',
        type: 'checkbox',
        group: 'O — Objective · 31. Balance',
      },

      {
        id: 'vestibularTests',
        label: 'Vestibular tests',
        type: 'rows',
        group: 'O — Objective · 32. Vestibular examination',
        columns: [
          { id: 'test', label: 'Test', type: 'text' },
          { id: 'result', label: 'Result', type: 'text' },
          { id: 'nystagmus', label: 'Nystagmus (direction / latency / duration)', type: 'text' },
          { id: 'symptomsProvoked', label: 'Symptoms provoked', type: 'text' },
          { id: 'comments', label: 'Comments', type: 'text' },
        ],
      },
      {
        id: 'vestibularImpression',
        label: 'Impression',
        type: 'select',
        options: ['BPPV', 'Unilateral hypofunction', 'Bilateral hypofunction', 'Central', 'Cervicogenic', 'PPPD', 'Not vestibular'],
        group: 'O — Objective · 32. Vestibular examination',
      },
      {
        id: 'bppvCanal',
        label: 'BPPV — canal',
        type: 'text',
        group: 'O — Objective · 32. Vestibular examination',
      },
      {
        id: 'dizzinessHandicapInventory',
        label: 'Dizziness Handicap Inventory (/100)',
        type: 'number',
        group: 'O — Objective · 32. Vestibular examination',
      },
      {
        id: 'vssAbcScale',
        label: 'VSS / ABC scale',
        type: 'text',
        group: 'O — Objective · 32. Vestibular examination',
      },
      {
        id: 'repositioningManoeuvrePerformed',
        label: 'Repositioning manoeuvre performed',
        type: 'checkbox',
        group: 'O — Objective · 32. Vestibular examination',
      },
      {
        id: 'repositioningManoeuvreDetail',
        label: 'Repositioning manoeuvre — detail',
        type: 'text',
        group: 'O — Objective · 32. Vestibular examination',
      },

      // The paper grid has four mutually exclusive tick columns (independent,
      // supervision, assist ×1, assist ×2); they are one `level` column here,
      // because a row ticked in two of them is not a finding, it is a slip.
      {
        id: 'functionalTasks',
        label: 'Functional tasks',
        type: 'rows',
        group: 'O — Objective · 33. Functional assessment',
        columns: [
          { id: 'task', label: 'Task', type: 'text' },
          {
            id: 'level',
            label: 'Level',
            type: 'select',
            options: ['Independent', 'Supervision', 'Assist ×1', 'Assist ×2', 'Unable'],
          },
          { id: 'aidUsed', label: 'Aid used', type: 'text' },
          { id: 'qualityCompensations', label: 'Quality / compensations', type: 'text' },
          { id: 'time', label: 'Time', type: 'text' },
        ],
      },

      {
        id: 'outcomeMeasures',
        label: 'Outcome measures',
        type: 'rows',
        group: 'O — Objective · 34. Outcome measures',
        columns: [
          { id: 'measure', label: 'Measure', type: 'text' },
          { id: 'baselineScore', label: 'Baseline score', type: 'text' },
          { id: 'date', label: 'Date', type: 'date' },
          { id: 'mcidTarget', label: 'MCID / target', type: 'text' },
          { id: 'reassessmentDate', label: 'Re-assessment date', type: 'date' },
          { id: 'score', label: 'Score', type: 'text' },
          { id: 'change', label: 'Change', type: 'text' },
        ],
      },

      // `clinicianImpression` and `workingDiagnosis` below keep the ids the
      // placeholder section used. The template is not history — a stored answer
      // survives a template change — but where the owner's real form asks the
      // same question the placeholder did, reusing the id means the answer lands
      // in the right box rather than beside an empty one.
      {
        id: 'clinicianImpression',
        label: 'Synthesis of subjective and objective findings — what fits, what does not, and why',
        type: 'textarea',
        group: 'A — Assessment · 35. Clinical impression',
      },

      {
        id: 'problemList',
        label: 'Problem list',
        type: 'rows',
        group: 'A — Assessment · 36. Problem list — ICF framework',
        columns: [
          {
            id: 'icfDomain',
            label: 'ICF domain',
            type: 'select',
            options: ['Body structures & functions (impairments)', 'Activity limitations', 'Participation restrictions', 'Environmental factors (barriers / facilitators)', 'Personal factors (beliefs, comorbidity, motivation)'],
          },
          { id: 'identifiedProblems', label: 'Identified problems', type: 'text' },
          { id: 'evidenceMeasure', label: 'Evidence / measure', type: 'text' },
          { id: 'priority', label: 'Priority (1–5)', type: 'number' },
        ],
      },

      {
        id: 'workingDiagnosis',
        label: 'Physiotherapy diagnosis (structure / tissue / mechanism / stage / severity / irritability)',
        type: 'textarea',
        group: 'A — Assessment · 37. Working diagnosis',
      },
      {
        id: 'medicalDiagnosisIcdCode',
        label: 'Medical diagnosis / ICD code (if applicable)',
        type: 'text',
        group: 'A — Assessment · 37. Working diagnosis',
      },
      {
        id: 'tissueHealingStage',
        label: 'Tissue healing stage',
        type: 'select',
        options: ['Inflammatory', 'Proliferative', 'Remodelling'],
        group: 'A — Assessment · 37. Working diagnosis',
      },
      {
        id: 'dominantPainMechanism',
        label: 'Dominant pain mechanism',
        type: 'text',
        group: 'A — Assessment · 37. Working diagnosis',
      },
      {
        id: 'contributingFactors',
        label: 'Contributing factors (biomechanical, load, lifestyle, psychosocial)',
        type: 'textarea',
        group: 'A — Assessment · 37. Working diagnosis',
      },

      {
        id: 'differentialDiagnoses',
        label: 'Differential diagnoses',
        type: 'rows',
        group: 'A — Assessment · 38. Differential diagnosis',
        columns: [
          { id: 'differential', label: 'Differential', type: 'text' },
          { id: 'supportingFeatures', label: 'Supporting features', type: 'text' },
          { id: 'featuresAgainst', label: 'Features against', type: 'text' },
          { id: 'testToConfirm', label: 'Test to confirm / exclude', type: 'text' },
          {
            id: 'status',
            label: 'Status',
            type: 'select',
            options: ['Ruled in', 'Ruled out', 'Pending'],
          },
        ],
      },

      {
        id: 'expectedOutcome',
        label: 'Expected outcome',
        type: 'select',
        options: ['Full recovery', 'Good functional recovery with residual impairment', 'Partial — self-management focus', 'Maintenance / palliative'],
        group: 'A — Assessment · 39. Prognosis',
      },
      {
        id: 'expectedTimeframe',
        label: 'Expected timeframe',
        type: 'text',
        group: 'A — Assessment · 39. Prognosis',
      },
      {
        id: 'anticipatedSessions',
        label: 'Anticipated number of sessions',
        type: 'number',
        group: 'A — Assessment · 39. Prognosis',
      },
      {
        id: 'prognosisReviewPoint',
        label: 'Review point',
        type: 'date',
        group: 'A — Assessment · 39. Prognosis',
      },
      {
        id: 'prognosticFactors',
        label: 'Prognostic factors',
        type: 'rows',
        group: 'A — Assessment · 39. Prognosis',
        columns: [
          { id: 'factor', label: 'Factor', type: 'text' },
          {
            id: 'direction',
            label: 'Direction',
            type: 'select',
            options: ['Positive', 'Negative / barrier'],
          },
        ],
      },
      {
        id: 'prognosisRationale',
        label: 'Rationale for prognosis (evidence, natural history, patient factors)',
        type: 'textarea',
        group: 'A — Assessment · 39. Prognosis',
      },

      {
        id: 'shortTermGoals',
        label: 'Short-term goals (0–4 weeks)',
        type: 'rows',
        group: 'P — Plan · 40. SMART goals',
        columns: [
          { id: 'goal', label: 'Goal statement (SMART)', type: 'text' },
          { id: 'baseline', label: 'Baseline', type: 'text' },
          { id: 'target', label: 'Target', type: 'text' },
          { id: 'targetDate', label: 'Target date', type: 'date' },
          { id: 'measureUsed', label: 'Measure used', type: 'text' },
          { id: 'achieved', label: 'Achieved', type: 'select', options: ['Yes', 'No', 'Partial'] },
        ],
      },
      {
        id: 'longTermGoals',
        label: 'Long-term goals (discharge / return to role)',
        type: 'rows',
        group: 'P — Plan · 40. SMART goals',
        columns: [
          { id: 'goal', label: 'Goal statement (SMART)', type: 'text' },
          { id: 'baseline', label: 'Baseline', type: 'text' },
          { id: 'target', label: 'Target', type: 'text' },
          { id: 'targetDate', label: 'Target date', type: 'date' },
          { id: 'measureUsed', label: 'Measure used', type: 'text' },
          { id: 'achieved', label: 'Achieved', type: 'select', options: ['Yes', 'No', 'Partial'] },
        ],
      },
      {
        id: 'goalsAgreedWithPatient',
        label: 'Goals agreed with patient',
        type: 'select',
        options: ['Yes', 'Adapted'],
        group: 'P — Plan · 40. SMART goals',
      },
      {
        id: 'goalsAdaptedReason',
        label: 'Goals adapted — reason',
        type: 'text',
        group: 'P — Plan · 40. SMART goals',
      },
      {
        id: 'goalsCopyGivenToPatient',
        label: 'Copy given to patient',
        type: 'checkbox',
        group: 'P — Plan · 40. SMART goals',
      },

      {
        id: 'immediateManagement',
        label: 'Interventions this session',
        type: 'rows',
        group: 'P — Plan · 41. Immediate management (this session)',
        columns: [
          { id: 'intervention', label: 'Intervention', type: 'text' },
          { id: 'details', label: 'Details (dose, parameters, technique)', type: 'text' },
          { id: 'responseEffect', label: 'Response / effect', type: 'text' },
        ],
      },
      {
        id: 'precautionsAppliedThisSession',
        label: 'Precautions applied this session',
        type: 'textarea',
        group: 'P — Plan · 41. Immediate management (this session)',
      },
      {
        id: 'adverseEvents',
        label: 'Adverse events',
        type: 'checkbox',
        group: 'P — Plan · 41. Immediate management (this session)',
      },
      {
        id: 'adverseEventsDetail',
        label: 'Adverse events — detail & action',
        type: 'textarea',
        group: 'P — Plan · 41. Immediate management (this session)',
      },

      {
        id: 'homeExerciseProgramme',
        label: 'Home exercise programme',
        type: 'rows',
        group: 'P — Plan · 42. Home exercise programme',
        columns: [
          { id: 'exercise', label: 'Exercise', type: 'text' },
          { id: 'purpose', label: 'Purpose', type: 'text' },
          { id: 'setsRepsHold', label: 'Sets × reps / hold', type: 'text' },
          { id: 'frequency', label: 'Frequency', type: 'text' },
          { id: 'loadProgression', label: 'Load / progression', type: 'text' },
          { id: 'painRule', label: 'Pain rule', type: 'text' },
          { id: 'taughtAndChecked', label: 'Taught & checked', type: 'checkbox' },
        ],
      },
      ...ticks('P — Plan · 42. Home exercise programme', [
        ['hepPrintedSheet', 'Format given — printed sheet'],
        ['hepAppVideoLink', 'Format given — app / video link'],
        ['hepPhotos', 'Format given — photos'],
        ['hepWrittenByPatient', 'Format given — written by patient'],
        ['hepCarerInstructed', 'Format given — carer instructed'],
      ]),
      {
        id: 'techniqueDemonstratedBack',
        label: 'Technique demonstrated back correctly',
        type: 'select',
        options: ['Yes', 'Partly — to review'],
        group: 'P — Plan · 42. Home exercise programme',
      },
      {
        id: 'expectedAdherenceBarriers',
        label: 'Expected adherence barriers',
        type: 'text',
        group: 'P — Plan · 42. Home exercise programme',
      },
      {
        id: 'activityModificationPacingPlan',
        label: 'Activity modification / pacing plan',
        type: 'textarea',
        group: 'P — Plan · 42. Home exercise programme',
      },
      {
        id: 'loadManagementFlareUpPlan',
        label: 'Load management & flare-up plan',
        type: 'textarea',
        group: 'P — Plan · 42. Home exercise programme',
      },

      ...ticks('P — Plan · 43. Education provided', [
        ['eduDiagnosisExplanation', 'Diagnosis & explanation of findings'],
        ['eduPainNeuroscience', 'Pain neuroscience education'],
        ['eduNaturalHistory', 'Natural history & expected recovery'],
        ['eduStayingActive', 'Importance of staying active'],
        ['eduActivityPacing', 'Activity pacing & graded exposure'],
        ['eduPostureErgonomics', 'Posture & ergonomics'],
        ['eduManualHandling', 'Manual handling / lifting technique'],
        ['eduExerciseTechniqueDosage', 'Exercise technique & dosage'],
        ['eduLoadManagementFlareUp', 'Load management & flare-up plan'],
        ['eduMedicationTiming', 'Medication use & timing with exercise'],
        ['eduSleepHygiene', 'Sleep hygiene'],
        ['eduWeightManagementNutrition', 'Weight management / nutrition'],
        ['eduSmokingCessation', 'Smoking cessation advice'],
        ['eduFallsPrevention', 'Falls prevention & home safety'],
        ['eduUseOfAidOrthosisFootwear', 'Use of aid / orthosis / footwear'],
        ['eduWoundScarCare', 'Wound / scar care'],
        ['eduReturnToWorkPlanning', 'Return-to-work planning'],
        ['eduReturnToSportCriteria', 'Return-to-sport criteria'],
        ['eduRedFlagSafetyNetting', 'Red flag safety-netting'],
        ['eduSelfManagementResources', 'Self-management resources / websites'],
      ]),
      ...ticks('P — Plan · 43. Education provided', [
        ['eduFormatVerbal', 'Education format — verbal'],
        ['eduFormatWritten', 'Education format — written'],
        ['eduFormatDigital', 'Education format — digital'],
        ['eduFormatInterpreterUsed', 'Education format — interpreter used'],
      ]),
      {
        id: 'understandingCheckedByTeachBack',
        label: 'Understanding checked by teach-back',
        type: 'checkbox',
        group: 'P — Plan · 43. Education provided',
      },
      {
        id: 'questionsRaisedByPatientCarer',
        label: 'Questions raised by patient / carer',
        type: 'textarea',
        group: 'P — Plan · 43. Education provided',
      },

      {
        id: 'followUpSchedule',
        label: 'Follow-up appointments',
        type: 'rows',
        group: 'P — Plan · 44. Follow-up schedule',
        columns: [
          { id: 'appointment', label: 'Appointment', type: 'text' },
          { id: 'dateInterval', label: 'Date / interval', type: 'text' },
          { id: 'mode', label: 'Mode', type: 'select', options: ['Face-to-face', 'Tele', 'Group'] },
          { id: 'focusOfSession', label: 'Focus of session', type: 'text' },
          { id: 'booked', label: 'Booked', type: 'checkbox' },
        ],
      },
      {
        id: 'plannedFrequencyPerWeek',
        label: 'Planned frequency (per week)',
        type: 'number',
        group: 'P — Plan · 44. Follow-up schedule',
      },
      {
        id: 'plannedNumberOfWeeks',
        label: 'Planned duration (weeks)',
        type: 'number',
        group: 'P — Plan · 44. Follow-up schedule',
      },
      {
        id: 'reviewReassessmentDate',
        label: 'Review / re-assessment date',
        type: 'date',
        group: 'P — Plan · 44. Follow-up schedule',
      },
      {
        id: 'estimatedDischargeDate',
        label: 'Estimated discharge',
        type: 'date',
        group: 'P — Plan · 44. Follow-up schedule',
      },
      {
        id: 'dischargeCriteria',
        label: 'Discharge criteria',
        type: 'textarea',
        group: 'P — Plan · 44. Follow-up schedule',
      },
      {
        id: 'nonAttendancePolicyExplained',
        label: 'Non-attendance policy explained',
        type: 'checkbox',
        group: 'P — Plan · 44. Follow-up schedule',
      },
      {
        id: 'contactRouteBetweenSessions',
        label: 'Contact route for concerns between sessions',
        type: 'text',
        group: 'P — Plan · 44. Follow-up schedule',
      },

      // The paper form ends in three signature lines. A drawn signature is not a
      // field type this template has, and typing a name into a text box is an
      // attestation rather than a signature — so what is recorded here is who
      // completed the assessment, their registration number, who countersigned,
      // and the dates. If the practice needs a real signature, that is its own
      // decision (an attachment, or a signing step), not a text field.
      {
        id: 'onwardReferrals',
        label: 'Onward referrals',
        type: 'rows',
        group: 'P — Plan · 45. Referral & onward recommendations',
        columns: [
          { id: 'referredTo', label: 'Referred to', type: 'text' },
          { id: 'reason', label: 'Reason', type: 'text' },
          { id: 'urgency', label: 'Urgency', type: 'text' },
          { id: 'dateSent', label: 'Date sent', type: 'date' },
          { id: 'responseOutcome', label: 'Response / outcome', type: 'text' },
        ],
      },
      {
        id: 'communicationSentToReferrer',
        label: 'Communication sent to referrer',
        type: 'select',
        options: ['Letter', 'Email', 'Electronic record'],
        group: 'P — Plan · 45. Referral & onward recommendations',
      },
      {
        id: 'communicationSentDate',
        label: 'Communication sent — date',
        type: 'date',
        group: 'P — Plan · 45. Referral & onward recommendations',
      },
      {
        id: 'assessmentCompletedBy',
        label: 'Assessment completed by (print)',
        type: 'text',
        group: 'P — Plan · 45. Referral & onward recommendations',
      },
      {
        id: 'assessmentCompletedDate',
        label: 'Assessment completed — date',
        type: 'date',
        group: 'P — Plan · 45. Referral & onward recommendations',
      },
      {
        id: 'countersignedBy',
        label: 'Countersigned (if student / band 5 supervision)',
        type: 'text',
        group: 'P — Plan · 45. Referral & onward recommendations',
      },
      {
        id: 'patientCarerAcknowledgedPlan',
        label: 'Patient / carer acknowledgement of plan',
        type: 'checkbox',
        group: 'P — Plan · 45. Referral & onward recommendations',
      },
      {
        id: 'patientCarerAcknowledgedDate',
        label: 'Patient / carer acknowledgement — date',
        type: 'date',
        group: 'P — Plan · 45. Referral & onward recommendations',
      },
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
