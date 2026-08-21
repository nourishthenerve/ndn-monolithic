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

export type Role = 'patient' | 'sub-clinician' | 'principal-clinician';

/**
 * Deliberately no `'delete'`. docs/plan/04-data-model-rbac.md's matrix has
 * `D = never` in every cell of every row, so the action is unrepresentable
 * rather than merely denied: "authorise a delete" is a compile error, the
 * same discipline Repository (services/api/src/repository.ts) gets from
 * having no method that removes a row. Do NOT add one — C-03 and
 * 00-conventions.md's prohibition are not policy this layer may decide.
 */
export type Action = 'create' | 'read' | 'update';

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
