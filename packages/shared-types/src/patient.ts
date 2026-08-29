// TASK 2.2.3: the first real entity built on `PersonRecord` (0.3.4), whose
// header has said since Phase 0 that "wiring a real entity (patient, …)
// onto it is Phase 2/3." This is that.
//
// The clinical/personal split is not a tidiness preference. R-04 and
// docs/compliance/dpia-skeleton.md turn on a future, human-authorised
// erasure of *specific non-clinical fields* being possible without a
// schema migration — which requires the two halves to be distinct
// top-level properties from the first record written, not separated later
// once there are records to migrate.
//
// So the rule for anyone adding a field: if it has a clinical retention
// basis, it goes in `clinical`. If its only basis is that the patient gave
// it to us, it goes in `personal`. There is no third place.
import type { BaseRecord } from './types.js';

/**
 * Given by the patient, retained because they gave it. A name, a way to
 * reach them, and whether they want to be marketed to.
 */
export interface PatientPersonal {
  fullName: string;
  email: string;
  phone?: string;
  marketingOptIn: boolean;
}

/**
 * Held on a clinical retention basis. Account creation (D-29: staff,
 * relaying what a patient gave over WhatsApp) writes at most the two
 * fields below and never anything else — a patient does not get to
 * declare their own diagnosis, and the assessment/care-plan entities that
 * do carry clinical content are Phase 3's.
 */
export interface PatientClinical {
  referralSource?: string;
  presentingCondition?: string;
}

/**
 * The lifecycle a clinician moves a patient through. **Every value is a
 * state, and none of them is a deleted row** — `declined` and `suspended`
 * both keep the record fully readable, which is what C-03 means when
 * applied to people rather than to content.
 *
 * Deliberately separate from `BaseRecord['status']` (`record_status` in
 * docs/plan/04-data-model-rbac.md's language): one says whether a person
 * may use the platform, the other says whether the row is live. Collapsing
 * them would make "declined" and "deleted" the same fact.
 */
export type PatientAccountStatus = 'pending' | 'approved' | 'declined' | 'suspended';

export interface Patient extends BaseRecord {
  /** The Cognito `sub` — see services/api/src/dynamo-principal-directory.ts for why the two are the same value. */
  id: string;
  clinical: PatientClinical;
  personal: PatientPersonal;
  account_status: PatientAccountStatus;
  /** Set by TASK 2.5.1's assignment, absent until then. Every relationship check in `can()` tests against it. */
  assigned_clinician_id?: string;
  /** Reserved for the caseload search TASK 2.5.3 builds. Empty on a newly-created record. */
  keywords: string[];
}

/** The statuses that let `can()` see an operative account. Exactly one, today and deliberately. */
export const OPERATIVE_PATIENT_STATUSES: readonly PatientAccountStatus[] = ['approved'];
