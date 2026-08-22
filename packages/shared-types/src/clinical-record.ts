// TASK 3.2.1: diagnosis and care plan — `04-data-model-rbac.md`'s
// "Versioned, append-only" entity, and R-09's first real `private{}`
// payload. One shape, instantiated against two key prefixes (`DIAG#`/
// `PLAN#`, services/api/src/clinical-record-repository.ts) rather than two
// near-identical interfaces — diagnosis and care plan differ only in which
// prefix they version under, never in shape.
//
// Deliberately does NOT extend `VersionedRecord`
// (services/api/src/versioned-repository.ts): that type lives in
// services/api, and shared-types is the base layer every workspace
// (services/api, apps/web, apps/mobile) depends on, never the reverse.
// `version: number` is declared directly here instead — structurally
// identical to `VersionedRecord`, so `VersionedRepository<ClinicalRecord>`
// is satisfied without an import that would invert the dependency graph.
import type { BaseRecord } from './types.js';

export interface ClinicalRecordVisible {
  readonly summary: string;
}

export interface ClinicalRecordPrivate {
  readonly notes: string;
}

export interface ClinicalRecord extends BaseRecord {
  readonly version: number;
  readonly patientId: string;
  readonly visible: ClinicalRecordVisible;
  /** Present only on a version a clinician chose to add private notes to — absent, not empty, otherwise (R-09). */
  readonly private?: ClinicalRecordPrivate;
}
