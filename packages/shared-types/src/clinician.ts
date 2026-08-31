// TASK 2.4.1: the clinician directory's record shape —
// docs/plan/04-data-model-rbac.md's `CLI#<id>` / `PROFILE`.
//
// **Two deliberate deviations from this task's own stated interface,**
// both forced by code that already existed when this task started:
//
// 1. No separate `subjectId` field. `id` *is* the Cognito `sub` — the same
//    "the two are the same value" convention `Patient.id` already
//    documents (patient.ts), and for the same reason
//    services/api/src/dynamo-principal-directory.ts settles for clinicians:
//    the `CLI#` record is keyed by the sub, so a second field holding the
//    identical value would be data with nowhere to disagree from itself.
// 2. `account_status`, not `active: boolean`. `dynamo-principal-directory.ts`
//    reads a literal `account_status` attribute off *every* `CLI#`/`PROFILE`
//    row to resolve a signed-in clinician's `Principal.accountStatus` — it
//    was written generically over both pools before this task existed.
//    Naming the field anything else would leave a real, active clinician
//    unable to reach a single authenticated route.
import type { AccountStatus } from './principal.js';
import type { BaseRecord } from './types.js';

/**
 * `'helpdesk'` (2026-08-31): the record side of `Role`'s own
 * `'helpdesk'` (principal.ts). Kept in this union rather than given a
 * separate entity because a helpdesk account is administered exactly like
 * a clinician account — same pool, same `CLI#<sub>`/`PROFILE` row, same
 * create/deactivate/reactivate routes — and differs only in which
 * `cognito:groups` membership it carries and therefore which matrix
 * column governs it. A second entity would duplicate every one of those
 * mechanics to express one different word.
 *
 * The "exactly one principal" invariant is unaffected: it is conditioned
 * on `role === 'principal'` alone (clinician-repository.ts), so any
 * number of `'helpdesk'` rows may exist alongside it.
 */
export type ClinicianRole = 'principal' | 'sub' | 'helpdesk';

export interface Clinician extends BaseRecord {
  /** The Cognito `sub` in the clinician pool. See this file's header. */
  id: string;
  displayName: string;
  role: ClinicianRole;
  /**
   * `principal.ts`'s own comment: "a clinician is `active` | `deactivated`."
   * Never `pending`/`approved`/`declined`/`suspended` — those are a
   * patient's lifecycle, not this one's.
   */
  account_status: Extract<AccountStatus, 'active' | 'deactivated'>;
}
