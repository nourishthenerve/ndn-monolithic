// TASK 3.3.1: one `VersionedRepository<Assessment>`, the same pattern
// clinical-record-repository.ts already established for diagnosis/care
// plan — except an assessment versions per *named form*, not per patient
// alone, so every method here takes a `patientId` and an `assessmentId`
// and combines them into the one composite `id` `VersionedRepository`
// itself knows about.
import type { Assessment } from '@ndn/shared-types';

import type { ActorContext, AuditWriter } from './audit.js';
import { ASSESSMENT_ENTITY_TYPE } from './authz-matrix.js';
import type { Clock } from './clock.js';
import type { Unprojected } from './projection.js';
import type { KeyValueStore } from './store.js';
import { VersionedRepository } from './versioned-repository.js';

/** What a caller supplies to create a version — never `patientId`/`assessmentId`/`version`, which the repository method's own parameters already carry. */
export interface AssessmentInput {
  readonly visible: Assessment['visible'];
  /** Omit entirely for a version with no clinician impression — see `Assessment['private']`'s own doc. */
  readonly private?: Assessment['private'];
}

/**
 * `VersionedRepository`'s own `id` is one string; this class is what
 * turns "which patient, which named form" into that one string and back
 * — `${patientId}#${assessmentId}`, unambiguous because a patient id is a
 * Cognito `sub` (a UUID, never containing `#`), the same guarantee
 * `caseload-repository.ts`'s own GSI3 parsing already relies on.
 */
function compositeId(patientId: string, assessmentId: string): string {
  return `${patientId}#${assessmentId}`;
}

export class AssessmentRepository {
  private readonly versioned: VersionedRepository<Assessment>;

  constructor(store: KeyValueStore<Assessment>, audit: AuditWriter, clock: Clock) {
    this.versioned = new VersionedRepository<Assessment>(
      store,
      audit,
      clock,
      ASSESSMENT_ENTITY_TYPE,
    );
  }

  createVersion(
    patientId: string,
    assessmentId: string,
    version: number,
    actor: ActorContext,
    input: AssessmentInput,
  ): Promise<Unprojected<Assessment>> {
    return this.versioned.createVersion(compositeId(patientId, assessmentId), version, actor, {
      patientId,
      assessmentId,
      ...input,
    });
  }

  getVersion(
    patientId: string,
    assessmentId: string,
    version: number,
  ): Promise<Unprojected<Assessment> | undefined> {
    return this.versioned.getVersion(compositeId(patientId, assessmentId), version);
  }

  listVersions(patientId: string, assessmentId: string): Promise<Unprojected<Assessment>[]> {
    return this.versioned.listVersions(compositeId(patientId, assessmentId));
  }
}
