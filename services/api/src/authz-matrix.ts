// TASK 2.1.1: docs/plan/04-data-model-rbac.md's RBAC matrix, transcribed
// cell for cell. This file is a *transcription*, not a design — the doc is
// the authority, and the keys below are the doc's own row and column
// labels so a reviewer can hold the two side by side and match every cell
// without reading intent out of `if` statements. Each entry carries the
// doc's markdown row verbatim as a comment directly above it.
//
// Rules for changing this file: change docs/plan/04-data-model-rbac.md
// first, then transcribe. The generated suite in authz.test.ts holds its
// own independent copy of the table, so a widened cell here fails a named
// test rather than passing silently.
//
// 2026-08-31 adds the doc's `Helpdesk` column — an administrative account
// in the clinician pool with no clinical reach at all. Read that column
// down the table rather than across this file's own diff: it is defined
// by what it is denied (every clinical row, assignment, clinician
// accounts, the audit log) far more than by the four cells it holds. The
// doc's own note on it is the reasoning; this is the transcription.
//
// Two transcription notes, both presentational only:
//   * the doc's markdown emphasis (`**R**`, `**—**`) is dropped — it marks
//     the two cells the doc wants a reader to notice, not a different
//     permission;
//   * the doc's in-cell qualifiers ("(self)", "(own thread)", "(own
//     patients)") are relationship statements, and the relationship is
//     already what picks the *column* — see authz.ts's column resolution.
//     "(deactivate only)" is the one qualifier that is not about
//     relationship: it constrains what a principal clinician's `update` on
//     a clinician account may do, which is TASK 2.4.1's business, not this
//     layer's. Both are kept verbatim in the row comments.
import type { Action, FieldSet } from '@ndn/shared-types';

/** The doc's table rows, verbatim. */
export type MatrixRow =
  | 'Own profile'
  | 'Patient profile'
  | 'Patient assignment'
  | 'Diagnosis / care plan'
  | 'Assessment — `general{}`'
  | 'Assessment — `patient{}`'
  | 'Assessment — `private{}`'
  | 'Assessment — `calendar{}`'
  | 'Appointments'
  | 'Appointment approval'
  | 'Patient notifications'
  | 'Content assignment'
  | 'Messages'
  | 'Clinician accounts'
  | 'Audit log'
  | 'Content item'
  | 'Testimonial moderation'
  | 'Workshop';

/** The doc's table columns, verbatim. */
export type MatrixColumn =
  | 'Patient (own)'
  | 'Patient (other)'
  | 'Sub-clinician (assigned)'
  | 'Sub-clinician (unassigned)'
  | 'Helpdesk'
  | 'Visitor'
  | 'Principal';

export type MatrixCell = readonly Action[];

export type RbacMatrix = Readonly<Record<MatrixRow, Readonly<Record<MatrixColumn, MatrixCell>>>>;

/** The doc's `—`. One shared empty cell so a denial cannot be mistyped. */
const DENIED: MatrixCell = [];

export const RBAC_MATRIX: RbacMatrix = {
  // | Own profile | R U | — | R U | — | R U | R U | R U |
  'Own profile': {
    'Patient (own)': ['read', 'update'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: ['read', 'update'],
    Visitor: ['read', 'update'],
    Principal: ['read', 'update'],
  },
  // D-29 (2026-08-29): `C` and `P` added to Principal — see this row's own
  // note in docs/plan/04-data-model-rbac.md. Self-registration is retired;
  // a patient account is now created, and its password reset, by a
  // principal only.
  // | Patient profile | R U (self) | — | R U | — | C R U P | **R (IIC-tagged only)** | C R U P |
  'Patient profile': {
    'Patient (own)': ['read', 'update'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: ['create', 'read', 'update', 'reset-password'],
    Visitor: ['read'],
    Principal: ['create', 'read', 'update', 'reset-password'],
  },
  // | Patient assignment | — | — | — | — | — | — | C R U |
  // TASK 2.5.1: the doc was silent on this row — no cell governed
  // approving/declining a patient's assignment. Settled here, explicitly,
  // rather than left to fall out of "Patient profile"'s relationship
  // logic: only the principal ever creates, reads or updates an
  // assignment decision. A sub-clinician is denied even onto themselves —
  // step 5's "only onto themselves, if the matrix allows it at all"
  // resolves to "it does not": a sub-clinician cannot already be the
  // resource's `assignedClinicianId` before the very decision that would
  // make them so, and this row denies both `Sub-clinician` columns
  // outright rather than leaving that resolved by accident of
  // relationship-matching.
  'Patient assignment': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': DENIED,
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // | Diagnosis / care plan | **R** | — | C R U | — | **—** | **—** | C R U |
  'Diagnosis / care plan': {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // 2026-09-01: the doc's two assessment rows became four — one per
  // section of the owner's own form, because "visible" was never a
  // section, it was "everything that isn't private", and helpdesk's reach
  // is not a prefix of anyone else's. See the doc's own note; this is the
  // transcription.
  //
  // Two cells here are narrower in practice than they read, and neither
  // narrowing belongs in this file:
  //   * `Visitor: R` on `general{}`/`calendar{}` reaches IIC-tagged
  //     patients only. The matrix has no vocabulary for "rows where a
  //     field equals a value" — the same reason the doc's own `Patient
  //     profile` Visitor cell already carries that qualifier in words —
  //     so assessment.ts applies the tag filter, exactly as
  //     caseload-repository.ts does for the list.
  //   * `Patient (own): U` on `general{}` reaches every field of that
  //     section except `tag`, which `assessment-template.ts` marks
  //     `staffOnly`. A field is not a matrix row; see the doc's note on
  //     why this one field is narrower than its section.
  // | Assessment — `general{}` | **R U** | — | C R U | — | **C R U** | **R (IIC-tagged only)** | C R U |
  'Assessment — `general{}`': {
    'Patient (own)': ['read', 'update'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: ['create', 'read', 'update'],
    Visitor: ['read'],
    Principal: ['create', 'read', 'update'],
  },
  // | Assessment — `patient{}` | R | — | C R U | — | **C R U** | **—** | C R U |
  'Assessment — `patient{}`': {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: ['create', 'read', 'update'],
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // Unchanged in every cell, 2026-09-01 included — this is the row R-09's
  // own register entry names, and the one whose attribute name
  // projection.ts keys its runtime boundary off.
  // | **Assessment — `private{}`** | **—** | **—** | C R U | **—** | **—** | **—** | C R U |
  'Assessment — `private{}`': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // | Assessment — `calendar{}` | R | — | C R U | — | **R** | **R (IIC-tagged only)** | C R U |
  'Assessment — `calendar{}`': {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: ['read'],
    Visitor: ['read'],
    Principal: ['create', 'read', 'update'],
  },
  // TASK 4.2.1 added `J` (join-call) to the two parties actually on the
  // call — `Patient (own)` and `Sub-clinician (assigned)` — and withheld
  // it from `Principal`, who kept plain `R`.
  //
  // **Superseded 2026-08-31.** That narrowing rested on the principal
  // never being a party to a call, which was an assumption about the
  // practice rather than a rule about calls: the principal here is the
  // clinic's own practising clinician, so they routinely are. `can()`
  // resolves a principal by role alone, so it cannot tell "this
  // appointment's own clinician" from "any appointment" — the choice is
  // a principal who cannot run a video call with their own patient, or
  // one who could join a colleague's. See the doc's own note; this cell
  // is where that trade is reversed if the practice grows.
  // | Appointments | R J | — | C R U J | — | **R** | **R (count only)** | C R U J |
  Appointments: {
    'Patient (own)': ['read', 'join-call'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update', 'join-call'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: ['read'],
    Visitor: ['read'],
    Principal: ['create', 'read', 'update', 'join-call'],
  },
  // 2026-09-01: "any new appointment booked by the clinician needs to be
  // approved by the principal clinician." A distinct row from
  // `Appointments`, for the same reason `Patient assignment` is distinct
  // from `Patient profile`: booking a slot and deciding whether that
  // booking stands are two powers, and the entire point of the request is
  // that one role holds the first and a different role holds the second.
  //
  // `U` alone. There is no `C` — the appointment already exists, in
  // `pending-approval` — and no `R`, because `Appointments`'s own `R`
  // already returns every appointment with its status, which is the whole
  // of what a reader would want this row for.
  // | **Appointment approval** | — | — | — | — | — | — | **U** |
  'Appointment approval': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': DENIED,
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['update'],
  },
  // 2026-09-01: the patient's own in-app dashboard feed. One column
  // filled in, and the clinician columns' `—` is deliberate rather than an
  // omission: a notification is never created by an HTTP call, it is a
  // side effect of an appointment action already authorised on the two
  // rows above. `C` here would be a second, independently reachable way to
  // put a notice on a patient's dashboard.
  // | Patient notifications | **R U (own)** | — | — | — | — | — | — |
  'Patient notifications': {
    'Patient (own)': ['read', 'update'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': DENIED,
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: DENIED,
  },
  // | Content assignment | R | — | C R U | — | C R U | — | C R U |
  'Content assignment': {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: ['create', 'read', 'update'],
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // TASK 3.6.1: corrected from `R (own patients)` — the assigned
  // sub-clinician's cell was read-only, which does not match the row's
  // own key-shape description, "Patient↔clinician" (`04-data-model-
  // rbac.md`). Corrected in the doc first, then transcribed here, per
  // this file's own standing rule.
  // | Messages | C R (own thread) | — | C R (own patients) | — | **—** | **—** | C R |
  Messages: {
    'Patient (own)': ['create', 'read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read'],
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['create', 'read'],
  },
  // | Clinician accounts | — | — | — | — | **—** | — | C R U (deactivate only) |
  'Clinician accounts': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': DENIED,
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // | Audit log | — | — | — | — | — | — | R |
  'Audit log': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': DENIED,
    'Sub-clinician (unassigned)': DENIED,
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['read'],
  },
  // TASK 2.5.4: the three rows the doc's own note explains — clinic-wide
  // marketing/admin resources with no patient relationship to scope by,
  // so both `Sub-clinician` columns carry the identical cell on purpose.
  // | Content item | — | — | **R** | **R** | **R** | — | C R U |
  'Content item': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['read'],
    'Sub-clinician (unassigned)': ['read'],
    Helpdesk: ['read'],
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // | Testimonial moderation | — | — | C R U | C R U | — | — | C R U |
  'Testimonial moderation': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': ['create', 'read', 'update'],
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // | Workshop | — | — | **R** | **R** | — | — | C R U |
  Workshop: {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['read'],
    'Sub-clinician (unassigned)': ['read'],
    Helpdesk: DENIED,
    Visitor: DENIED,
    Principal: ['create', 'read', 'update'],
  },
};

/**
 * The closed vocabulary of `Resource.entityType`, mapped to the doc row it
 * is governed by. Anything absent from here is denied by `can()` — adding
 * an entity type is a deliberate edit to this map, never a fallthrough.
 *
 * `'assessment'` is deliberately NOT here: it is the one entity whose row
 * depends on which half of the record is being reached, and it resolves
 * through ASSESSMENT_ROWS instead so the doc's two assessment rows stay two
 * distinct lookups rather than one lookup plus a later filter.
 */
export const ENTITY_TYPE_ROWS = {
  'own-profile': 'Own profile',
  'patient-profile': 'Patient profile',
  'patient-assignment': 'Patient assignment',
  diagnosis: 'Diagnosis / care plan',
  'care-plan': 'Diagnosis / care plan',
  appointment: 'Appointments',
  'appointment-approval': 'Appointment approval',
  'patient-notification': 'Patient notifications',
  'content-assignment': 'Content assignment',
  message: 'Messages',
  'clinician-account': 'Clinician accounts',
  audit: 'Audit log',
  'content-item': 'Content item',
  'testimonial-moderation': 'Testimonial moderation',
  workshop: 'Workshop',
} as const satisfies Readonly<Record<string, MatrixRow>>;

export const ASSESSMENT_ENTITY_TYPE = 'assessment';

/**
 * One entry per `FieldSet` member, and the `satisfies` is what makes that
 * exhaustive: adding a section to the form without giving it a row here is
 * a compile error, never a section that quietly falls through to another
 * section's permissions.
 */
export const ASSESSMENT_ROWS = {
  general: 'Assessment — `general{}`',
  patient: 'Assessment — `patient{}`',
  private: 'Assessment — `private{}`',
  calendar: 'Assessment — `calendar{}`',
} as const satisfies Readonly<Record<FieldSet, MatrixRow>>;
