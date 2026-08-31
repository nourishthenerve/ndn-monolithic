// TASK 2.1.1: the authorisation spine's vocabulary. A `Principal` is the
// authenticated caller reduced to exactly what an authorisation decision
// needs — it is not a user profile, and nothing personal or clinical is
// allowed onto it (docs/plan/05-execution-plan.md, Phase 2's "no clinical
// or personal data enters Cognito"). Names, contact details and everything
// else live in the table under docs/plan/04-data-model-rbac.md's key
// shapes, keyed by `subjectId`.
//
// These types are in shared-types rather than services/api because the web
// shell (TASK 2.2.4) and the mobile app render off the same role and status
// vocabulary. The decision function itself is NOT here — `can()` lives in
// services/api/src/authz.ts and reads services/api/src/authz-matrix.ts.

/**
 * Two roles added 2026-08-31, both living in the *clinician* pool — they
 * sign in through the same button a clinician does — and both with no
 * clinical reach whatsoever. Neither is a kind of clinician:
 * `Clinician.role` gains the same values so the record and the token
 * agree, and the "exactly one principal" invariant is untouched (many of
 * either may exist).
 *
 *   * `'helpdesk'` — the patient's administrative proxy. Creates patient
 *     accounts, issues temporary passwords, reads and corrects any
 *     patient's details, reads their appointments, uploads and assigns
 *     content. Denied diagnoses, care plans, assessments and messages
 *     outright.
 *   * `'visitor'` — a partner organisation's read-only account, and the
 *     narrowest role in the system. It sees one thing: the patients
 *     tagged for its own programme, by name and address, with a count of
 *     the appointments that actually happened. It writes nothing, and it
 *     is the only role whose *set of patients* is narrowed by data
 *     (`Patient.tag`) rather than by a matrix column.
 *
 * docs/plan/04-data-model-rbac.md's columns are the authority;
 * services/api/src/authz-matrix.ts transcribes them, and
 * docs/runbooks/role-model.md reads the whole table back in prose.
 */
export type Role =
  | 'patient'
  | 'sub-clinician'
  | 'principal-clinician'
  | 'helpdesk'
  | 'visitor';

/**
 * Deliberately no `'delete'`. docs/plan/04-data-model-rbac.md's matrix has
 * `D = never` in every cell of every row, so the action is unrepresentable
 * rather than merely denied: "authorise a delete" is a compile error, the
 * same discipline Repository (services/api/src/repository.ts) gets from
 * having no method that removes a row. Do NOT add one — C-03 and
 * 00-conventions.md's prohibition are not policy this layer may decide.
 *
 * `'join-call'` (TASK 4.2.1): a stricter claim than `'read'` on the same
 * `Appointments` row — granted only to the two parties actually on the
 * call (`Patient (own)`, `Sub-clinician (assigned)`), never to `Principal`
 * even though the principal clinician can `read` every appointment.
 *
 * `'reset-password'` (D-29, 2026-08-29): issuing a patient a new Cognito
 * password is not `'update'` on their profile — it touches no field of the
 * `PAT#` record at all, only the directory. Named as its own action so a
 * reviewer of `authz-matrix.ts` sees exactly which cell governs handing
 * someone a credential, rather than that reach hiding inside a grant meant
 * for editing a name or a phone number.
 */
export type Action = 'create' | 'read' | 'update' | 'join-call' | 'reset-password';

/**
 * Both lifecycles in one union: a patient is `pending` → `approved` |
 * `declined`, and may later be `suspended`; a clinician is `active` |
 * `deactivated`. Neither ever leaves the table — C-03 extends to identity
 * in Phase 2 ("a patient is declined or suspended, a clinician is
 * deactivated, a Cognito user is disabled — never AdminDeleteUser").
 * `approved` and `active` are the two operative statuses; every other value
 * gates the principal down to reading its own profile (authz.ts).
 */
export type AccountStatus =
  'pending' | 'approved' | 'declined' | 'suspended' | 'active' | 'deactivated';

/** Which half of an assessment record is being reached — see Resource. */
export type FieldSet = 'visible' | 'private';

export interface Principal {
  /** The Cognito `sub`. Opaque here — this layer never resolves it. */
  readonly subjectId: string;
  readonly role: Role;
  readonly accountStatus: AccountStatus;
  /** Set for `patient`, and only for `patient`. */
  readonly patientId?: string;
  /** Set for either clinician role, and only for those. */
  readonly clinicianId?: string;
}

/**
 * The thing being reached, described only as far as the matrix needs: what
 * kind of row it is, and who it relates to. `entityType` is a `string`, not
 * a union, on purpose — an unrecognised entity type has to be a *runtime*
 * denial (deny-by-default), which a closed union would make unrepresentable
 * and therefore untestable. The recognised vocabulary is
 * services/api/src/authz-matrix.ts's `ENTITY_TYPE_ROWS`.
 */
export interface Resource {
  readonly entityType: string;
  readonly ownerPatientId?: string;
  readonly assignedClinicianId?: string;
  /** Required for `assessment`, ignored elsewhere. Absent = denied. */
  readonly fieldSet?: FieldSet;
}
