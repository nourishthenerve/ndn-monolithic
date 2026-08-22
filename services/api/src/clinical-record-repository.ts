// TASK 3.2.1: diagnosis and care plan share one shape and one task
// (clinical-record.ts's own header explains why), so one repository class
// is instantiated twice — once per `ClinicalRecordKind` — against two
// `VersionedRepository<ClinicalRecord>` instances keyed under two DynamoDB
// sort-key prefixes (`DynamoClinicalRecordStore`, dynamo-store.ts), not two
// parallel repository implementations.
import type { ClinicalRecord } from '@ndn/shared-types';

import type { ActorContext, AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import type { Unprojected } from './projection.js';
import type { KeyValueStore } from './store.js';
import { VersionedRepository } from './versioned-repository.js';

/**
 * The two entity types `authz-matrix.ts`'s `ENTITY_TYPE_ROWS` already maps
 * onto the single `'Diagnosis / care plan'` row — used here as-is for the
 * `VersionedRepository` audit `entityType` too, so an audit row and an
 * authorisation decision for the same write name the identical string.
 */
export type ClinicalRecordKind = 'diagnosis' | 'care-plan';

/** What a caller supplies to create a version — never `patientId`/`version`, which the repository method's own parameters already carry. */
export interface ClinicalRecordInput {
  readonly visible: ClinicalRecord['visible'];
  /** Omit entirely for a version with no private notes — see `ClinicalRecord['private']`'s own doc for why "absent" and "empty" are not the same thing here. */
  readonly private?: ClinicalRecord['private'];
}

export class ClinicalRecordRepository {
  private readonly versioned: VersionedRepository<ClinicalRecord>;

  constructor(
    store: KeyValueStore<ClinicalRecord>,
    audit: AuditWriter,
    clock: Clock,
    kind: ClinicalRecordKind,
  ) {
    this.versioned = new VersionedRepository<ClinicalRecord>(store, audit, clock, kind);
  }

  createVersion(
    patientId: string,
    version: number,
    actor: ActorContext,
    input: ClinicalRecordInput,
  ): Promise<Unprojected<ClinicalRecord>> {
    return this.versioned.createVersion(patientId, version, actor, { patientId, ...input });
  }

  getVersion(patientId: string, version: number): Promise<Unprojected<ClinicalRecord> | undefined> {
    return this.versioned.getVersion(patientId, version);
  }

  /** TASK 3.2.2: every version for `patientId`, oldest first — see `VersionedRepository.listVersions`'s own doc. */
  listVersions(patientId: string): Promise<Unprojected<ClinicalRecord>[]> {
    return this.versioned.listVersions(patientId);
  }
}
