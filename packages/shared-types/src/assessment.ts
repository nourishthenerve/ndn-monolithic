// TASK 3.3.1: the one entity `04-data-model-rbac.md` gives two dedicated
// matrix rows (`'Assessment — visible{}'`, `'Assessment — private{}'`,
// authz-matrix.ts, standing since TASK 2.1.1) — a named form (e.g.
// "initial mobility assessment") a clinician re-administers over time,
// versioned per sitting.
//
// Deliberately does NOT extend `VersionedRecord`
// (services/api/src/versioned-repository.ts) — the same layering reason
// `ClinicalRecord` (clinical-record.ts, TASK 3.2.1) declares `version:
// number` directly rather than importing it: shared-types is the base
// layer every workspace depends on, never the reverse.
import type { BaseRecord } from './types.js';

export interface AssessmentVisible {
  readonly formType: string;
  readonly responses: Record<string, unknown>;
}

export interface AssessmentPrivate {
  readonly clinicianImpression: string;
}

export interface Assessment extends BaseRecord {
  readonly version: number;
  readonly patientId: string;
  /** Which named form this is a sitting of, e.g. `"mobility-initial"` — distinct from `version`, which names *this* sitting among that form's own history. */
  readonly assessmentId: string;
  readonly visible: AssessmentVisible;
  /** Present only on a version a clinician chose to add a private impression to — absent, not empty, otherwise (R-09). */
  readonly private?: AssessmentPrivate;
}
