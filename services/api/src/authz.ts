// TASK 2.1.1: the one policy-decision point. Every handler written from
// here on asks `can()` and acts on the answer; no handler re-derives a
// permission from a role, and no permission lives anywhere but
// authz-matrix.ts's single const (docs/plan/05-execution-plan.md TASK
// 2.1.1's "Do NOT: scatter authorisation checks into handlers instead of
// calling can(); let the matrix live anywhere but the one const").
//
// Deny by default, everywhere: an unrecognised entity type, an
// unrecognised role, a principal whose identity link doesn't match its
// role, an assessment lookup that doesn't say which half it wants — each
// is a denial with a named reason, never a fallthrough. There is no
// `isAdmin` escape hatch and there will not be one; the principal
// clinician is a column of the matrix like any other.
import type { AccountStatus, Action, Principal, Resource, Role } from '@ndn/shared-types';

import type { MatrixColumn, MatrixRow } from './authz-matrix.js';
import {
  ASSESSMENT_ENTITY_TYPE,
  ASSESSMENT_ROWS,
  ENTITY_TYPE_ROWS,
  RBAC_MATRIX,
} from './authz-matrix.js';

export type DenyReason =
  /** The role is not one of `Role` — a token we do not understand. */
  | 'unknown-role'
  /** Role and identity link disagree, or the link is missing/empty. */
  | 'malformed-principal'
  /** `entityType` is not in ENTITY_TYPE_ROWS. */
  | 'unknown-entity-type'
  /** An `assessment` resource that didn't say `visible` or `private`. */
  | 'missing-field-set'
  /** Status is not `approved`/`active`, and this isn't its own profile read. */
  | 'account-not-active'
  /** Well-formed request, and the matrix cell does not list the action. */
  | 'matrix-denies';

export type Decision =
  | { readonly allowed: true; readonly row: MatrixRow; readonly column: MatrixColumn }
  | { readonly allowed: false; readonly reason: DenyReason };

/** Internal: a resolved coordinate, or the reason it could not be resolved. */
type Resolved<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: DenyReason };

function resolved<T>(value: T): Resolved<T> {
  return { ok: true, value };
}

function unresolved<T>(reason: DenyReason): Resolved<T> {
  return { ok: false, reason };
}

/**
 * The two statuses that carry full role permissions — `approved` is the
 * patient lifecycle's, `active` is the clinician lifecycle's. Every other
 * status (pending, declined, suspended, deactivated) is gated down to
 * reading its own profile, which is what lets a declined or suspended
 * person still see their own account rather than a blank wall.
 */
const OPERATIVE_STATUSES: readonly AccountStatus[] = ['approved', 'active'];

const OWN_PROFILE_ROW: MatrixRow = 'Own profile';

function isEntityType(value: string): value is keyof typeof ENTITY_TYPE_ROWS {
  return Object.prototype.hasOwnProperty.call(ENTITY_TYPE_ROWS, value);
}

/**
 * Which row of the doc's table governs this resource. `assessment` splits
 * on `fieldSet`; an assessment that doesn't say which half it wants is a
 * denial, not a guess at `visible`.
 */
function resolveRow(resource: Resource): Resolved<MatrixRow> {
  if (resource.entityType === ASSESSMENT_ENTITY_TYPE) {
    return resource.fieldSet
      ? resolved(ASSESSMENT_ROWS[resource.fieldSet])
      : unresolved('missing-field-set');
  }
  return isEntityType(resource.entityType)
    ? resolved(ENTITY_TYPE_ROWS[resource.entityType])
    : unresolved('unknown-entity-type');
}

function isLinked(id: string | undefined): id is string {
  return typeof id === 'string' && id.length > 0;
}

/**
 * Which column — role *and* relationship, never role alone. A
 * sub-clinician is "assigned" only when the resource names their
 * `clinicianId`; a patient is "own" only when the resource names their
 * `patientId`. The comparison is safe against an unrelated resource
 * because the principal's own link is proven non-empty first: an absent
 * `ownerPatientId` can never equal a present `patientId`.
 *
 * A clinician's own profile is modelled as a resource assigned to
 * themselves (`assignedClinicianId === clinicianId`), which is how the
 * doc's "Own profile | … | R U | — | R U" row reads for both clinician
 * columns without a special case here.
 */
function resolveColumn(principal: Principal, resource: Resource): Resolved<MatrixColumn> {
  const role: Role = principal.role;
  switch (role) {
    case 'patient':
      if (!isLinked(principal.patientId) || principal.clinicianId !== undefined) {
        return unresolved('malformed-principal');
      }
      return resolved(
        resource.ownerPatientId === principal.patientId ? 'Patient (own)' : 'Patient (other)',
      );
    case 'sub-clinician':
      if (!isLinked(principal.clinicianId) || principal.patientId !== undefined) {
        return unresolved('malformed-principal');
      }
      return resolved(
        resource.assignedClinicianId === principal.clinicianId
          ? 'Sub-clinician (assigned)'
          : 'Sub-clinician (unassigned)',
      );
    case 'principal-clinician':
      if (!isLinked(principal.clinicianId) || principal.patientId !== undefined) {
        return unresolved('malformed-principal');
      }
      return resolved('Principal');
    // 2026-08-31. Like `Principal` and unlike either sub-clinician column,
    // this one is role alone — a helpdesk account has no care relationship
    // to any patient, which is the point of it. It is still linked by
    // `clinicianId` (its record is a `CLI#` row in the clinician pool), so
    // the same malformed-principal check applies unchanged.
    case 'helpdesk':
      if (!isLinked(principal.clinicianId) || principal.patientId !== undefined) {
        return unresolved('malformed-principal');
      }
      return resolved('Helpdesk');
    // Role alone again, and for the same reason: a visitor has no care
    // relationship to anything. What narrows *which* patients they see is
    // not the column — it is the patient's own `tag`, applied by
    // caseload-repository.ts on the way out. The matrix says "may read a
    // patient profile at all"; the tag says "which ones".
    case 'visitor':
      if (!isLinked(principal.clinicianId) || principal.patientId !== undefined) {
        return unresolved('malformed-principal');
      }
      return resolved('Visitor');
    default:
      return unresolved('unknown-role');
  }
}

/**
 * The whole authorisation surface of this platform. Reads `RBAC_MATRIX`
 * and nothing else — no environment, no clock, no I/O — so a decision is a
 * pure function of (principal, action, resource) and every cell can be
 * asserted individually.
 */
export function can(principal: Principal, action: Action, resource: Resource): Decision {
  const row = resolveRow(resource);
  if (!row.ok) {
    return { allowed: false, reason: row.reason };
  }

  const column = resolveColumn(principal, resource);
  if (!column.ok) {
    return { allowed: false, reason: column.reason };
  }

  // Status gates before role does: a principal that is not approved/active
  // reaches its own profile, read-only, and nothing else. The matrix still
  // has the last word — an inoperative patient reading *someone else's*
  // profile lands in the 'Patient (other)' column and is denied there.
  if (
    !OPERATIVE_STATUSES.includes(principal.accountStatus) &&
    (row.value !== OWN_PROFILE_ROW || action !== 'read')
  ) {
    return { allowed: false, reason: 'account-not-active' };
  }

  return RBAC_MATRIX[row.value][column.value].includes(action)
    ? { allowed: true, row: row.value, column: column.value }
    : { allowed: false, reason: 'matrix-denies' };
}
