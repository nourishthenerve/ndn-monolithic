// TASK 3.3.1: the one entity `04-data-model-rbac.md` gives dedicated matrix
// rows *per section* (authz-matrix.ts, standing since TASK 2.1.1) — a named
// form a clinician re-administers over time, versioned per sitting.
//
// Deliberately does NOT extend `VersionedRecord`
// (services/api/src/versioned-repository.ts) — the same layering reason
// `ClinicalRecord` (clinical-record.ts, TASK 3.2.1) declares `version:
// number` directly rather than importing it: shared-types is the base
// layer every workspace depends on, never the reverse.
//
// ## 2026-09-01 — two sections became four, and why the third is still
// called `private`
//
// The owner: *"this assessment form will have three sections. 1. General
// info 2. Specific to the patient 3. Specific to the clinician"*, and then
// *"Therefore I think we need one more section along with … for
// calender."* The old shape was `visible{}` + `private{}`: one half
// everybody with a care relationship could read, one half only a clinician
// could. That is two of the four boundaries the owner drew, and it could
// not express the other two — helpdesk editing "specific to the patient"
// but not "general" alone, or a calendar every role reads and only a
// clinician writes.
//
// So the record now carries **one property per section, named exactly as
// `FieldSet` names it** (principal.ts). That equality is load-bearing, not
// cosmetic: the section-scoped write in services/api/src/assessment.ts
// indexes the stored record by the same string `can()` was asked about, so
// a permission and the bytes it governs cannot drift apart the way two
// parallel lists could.
//
// **`private` keeps its name deliberately.** It is the clinician-only
// section — the owner's "specific to the clinician" — and renaming it to
// match that phrase would silently unhook R-09's entire runtime boundary:
// `projection.ts`'s `stripPrivate`, `containsPrivateField` and
// `redactPrivateText` all key off the literal attribute name `private`,
// which is also what keeps clinical notes out of a log line and out of an
// error message. Those three functions are the reason a leak is a caught
// bug rather than a discovered one; the section's *label* is the
// template's business (assessment-template.ts), and the label there does
// say "Specific to the clinician".
import type { FieldSet } from './principal.js';
import type { BaseRecord } from './types.js';

/**
 * What a template field's answer may be. Deliberately narrow: an
 * assessment answer is something a person typed or picked, never a nested
 * structure. A section that needs richer content gets an attachment
 * (below), not a deeper `responses` tree — which also keeps `stripPrivate`'s
 * depth-first walk over a response bag cheap and total.
 */
export type AssessmentValue = string | number | boolean;

/**
 * A file uploaded into one section. The bytes live in S3 under
 * `assessments/<patientId>/<assessmentId>/<fieldSet>/…` (see
 * services/api/src/assessment-upload.ts); this is the metadata row that
 * points at them.
 *
 * **The section an attachment belongs to is its position in the record,
 * never a field on it.** An attachment inside `private{}` is a
 * clinician-only attachment because it is inside `private{}` — so it is
 * stripped by the same one line that strips every other private value,
 * and there is no second place for "which section was this again?" to be
 * answered differently.
 */
export interface AssessmentAttachment {
  /** The S3 object key. Always inside this patient/form/section's own prefix — the upload endpoint derives it and never accepts one. */
  readonly key: string;
  /** As uploaded, sanitised. Shown to a reader; never used to build the key. */
  readonly fileName: string;
  readonly contentType: string;
  readonly uploadedAt: string;
  /** The uploader's Cognito `sub` — an identifier, never a name (00-conventions.md). */
  readonly uploadedBy: string;
}

export interface AssessmentSection {
  /** Keyed by `AssessmentFieldDef.id` — the template says which ids are meaningful; an answer to a field the template no longer defines is kept, not dropped (a record is history, not a form's current shape). */
  readonly responses: Readonly<Record<string, AssessmentValue>>;
  readonly attachments: readonly AssessmentAttachment[];
}

export interface Assessment extends BaseRecord {
  readonly version: number;
  readonly patientId: string;
  /** Which named form this is a sitting of, e.g. `"intake-v1"` — distinct from `version`, which names *this* sitting among that form's own history. */
  readonly assessmentId: string;
  /** Section 1. Readable by every role with a relationship to the patient; writable by the patient themselves, helpdesk and both clinician roles. */
  readonly general: AssessmentSection;
  /** Section 2, "specific to the patient". The patient reads it and does not write it; helpdesk and both clinician roles write it. */
  readonly patient: AssessmentSection;
  /** Section 4, the calendar. Every role reads it; only a clinician writes it. Its appointment figures are derived on read and never stored — see `DERIVED_CALENDAR_FIELDS`. */
  readonly calendar: AssessmentSection;
  /**
   * Section 3, "specific to the clinician". Present only on a version a
   * clinician actually put something in — absent, not empty, otherwise
   * (R-09). Named `private` for the reason this file's header gives.
   */
  readonly private?: AssessmentSection;
}

/** The four section properties of an `Assessment`, in the order the form presents them. Every one is a `FieldSet` member and vice versa — asserted in `index.test.ts`. */
export const ASSESSMENT_SECTION_ORDER: readonly FieldSet[] = [
  'general',
  'patient',
  'private',
  'calendar',
];

/** An empty section — what a freshly instantiated form's every section starts as. */
export function emptyAssessmentSection(): AssessmentSection {
  return { responses: {}, attachments: [] };
}
