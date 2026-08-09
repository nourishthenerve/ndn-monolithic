// TASK 0.3.4: every person record splits into clinical{} (held on a
// clinical retention basis) and personal{} (name, contact, marketing
// preferences) so a future human-authorised erasure of specific
// non-clinical fields needs no schema migration — see
// docs/compliance/dpia-skeleton.md and docs/plan/02-risk-register.md's R-04.
// This is the generic primitive; wiring a real entity (patient, …) onto it
// is Phase 2/3, same as Repository/VersionedRepository (TASK 0.3.3). The
// two attribute sets are distinct top-level properties, and the helpers
// below only ever read or replace their own half — updating one can never
// touch the other. Do NOT add an erasure method here: the DPO/solicitor
// sign-off that would authorise one (R-04, LL-06) has not happened.
import type { BaseRecord } from './types.js';

export interface PersonRecord<Clinical, Personal> extends BaseRecord {
  readonly clinical: Clinical;
  readonly personal: Personal;
}

export function projectClinical<Clinical, Personal>(
  record: PersonRecord<Clinical, Personal>,
): Clinical {
  return record.clinical;
}

export function projectPersonal<Clinical, Personal>(
  record: PersonRecord<Clinical, Personal>,
): Personal {
  return record.personal;
}

export function withClinical<Clinical, Personal, R extends PersonRecord<Clinical, Personal>>(
  record: R,
  clinical: Clinical,
): R {
  return { ...record, clinical };
}

export function withPersonal<Clinical, Personal, R extends PersonRecord<Clinical, Personal>>(
  record: R,
  personal: Personal,
): R {
  return { ...record, personal };
}
