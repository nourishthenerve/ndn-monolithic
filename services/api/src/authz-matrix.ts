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
  | 'Assessment — `visible{}`'
  | 'Assessment — `private{}`'
  | 'Appointments'
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
  | 'Principal';

export type MatrixCell = readonly Action[];

export type RbacMatrix = Readonly<Record<MatrixRow, Readonly<Record<MatrixColumn, MatrixCell>>>>;

/** The doc's `—`. One shared empty cell so a denial cannot be mistyped. */
const DENIED: MatrixCell = [];

export const RBAC_MATRIX: RbacMatrix = {
  // | Own profile | R U | — | R U | — | R U |
  'Own profile': {
    'Patient (own)': ['read', 'update'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read', 'update'],
  },
  // | Patient profile | R U (self) | — | R U | — | R U |
  'Patient profile': {
    'Patient (own)': ['read', 'update'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read', 'update'],
  },
  // | Patient assignment | — | — | — | — | C R U |
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
    Principal: ['create', 'read', 'update'],
  },
  // | Diagnosis / care plan | **R** | — | C R U | — | C R U |
  'Diagnosis / care plan': {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // | Assessment — `visible{}` | R | — | C R U | — | R |
  'Assessment — `visible{}`': {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read'],
  },
  // | **Assessment — `private{}`** | **—** | **—** | C R U | **—** | R |
  'Assessment — `private{}`': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read'],
  },
  // | Appointments | R | — | C R U | — | R |
  Appointments: {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read'],
  },
  // | Content assignment | R | — | C R U | — | R |
  'Content assignment': {
    'Patient (own)': ['read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read'],
  },
  // TASK 3.6.1: corrected from `R (own patients)` — the assigned
  // sub-clinician's cell was read-only, which does not match the row's
  // own key-shape description, "Patient↔clinician" (`04-data-model-
  // rbac.md`). Corrected in the doc first, then transcribed here, per
  // this file's own standing rule.
  // | Messages | C R (own thread) | — | C R (own patients) | — | R |
  Messages: {
    'Patient (own)': ['create', 'read'],
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read'],
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read'],
  },
  // | Clinician accounts | — | — | — | — | C R U (deactivate only) |
  'Clinician accounts': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': DENIED,
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['create', 'read', 'update'],
  },
  // | Audit log | — | — | — | — | R |
  'Audit log': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': DENIED,
    'Sub-clinician (unassigned)': DENIED,
    Principal: ['read'],
  },
  // TASK 2.5.4: the three rows the doc's own note explains — clinic-wide
  // marketing/admin resources with no patient relationship to scope by,
  // so both `Sub-clinician` columns carry the identical cell on purpose.
  // | Content item | — | — | C R U | C R U | C R U |
  'Content item': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': ['create', 'read', 'update'],
    Principal: ['create', 'read', 'update'],
  },
  // | Testimonial moderation | — | — | C R U | C R U | C R U |
  'Testimonial moderation': {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': ['create', 'read', 'update'],
    Principal: ['create', 'read', 'update'],
  },
  // | Workshop | — | — | C R U | C R U | C R U |
  Workshop: {
    'Patient (own)': DENIED,
    'Patient (other)': DENIED,
    'Sub-clinician (assigned)': ['create', 'read', 'update'],
    'Sub-clinician (unassigned)': ['create', 'read', 'update'],
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
  'content-assignment': 'Content assignment',
  message: 'Messages',
  'clinician-account': 'Clinician accounts',
  audit: 'Audit log',
  'content-item': 'Content item',
  'testimonial-moderation': 'Testimonial moderation',
  workshop: 'Workshop',
} as const satisfies Readonly<Record<string, MatrixRow>>;

export const ASSESSMENT_ENTITY_TYPE = 'assessment';

export const ASSESSMENT_ROWS = {
  visible: 'Assessment — `visible{}`',
  private: 'Assessment — `private{}`',
} as const satisfies Readonly<Record<FieldSet, MatrixRow>>;
