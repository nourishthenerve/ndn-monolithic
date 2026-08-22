// TASK 0.3.3's versioned-record helper, for docs/plan/04-data-model-rbac.md's
// "Versioned, append-only" entities (diagnosis, care plan, assessment
// forms): each version is its own immutable key, so version N+1 can never
// mutate version N, and writing an already-existing version throws instead
// of silently overwriting it.
//
// TASK 2.1.3: `actor` is an `ActorContext` (audit.ts) here for the same
// reason it is in repository.ts — an audit row owes a `where`, and a
// parameter is what makes supplying it non-optional.
//
// TASK 2.1.2 (R-09): reads and writes hand back `Unprojected<T>` for the
// same reason repository.ts does — an assessment form, the one entity
// docs/plan/04-data-model-rbac.md gives a `private{}` half, is a versioned
// record, so this class is the read path 3.2.x wires through `projectFor`.
import type { BaseRecord } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { unprojected, type Unprojected } from './projection.js';
import type { KeyValueStore } from './store.js';

export interface VersionedRecord extends BaseRecord {
  readonly version: number;
}

export class VersionedRepository<T extends VersionedRecord> {
  constructor(
    private readonly store: KeyValueStore<T>,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
    private readonly entityType: string,
  ) {}

  async createVersion(
    id: string,
    version: number,
    actor: ActorContext,
    data: Omit<T, keyof BaseRecord | 'version'>,
  ): Promise<Unprojected<T>> {
    const key = this.versionKey(id, version);
    const existing = await this.store.get(key);
    if (existing) {
      throw new AppError(
        'VERSION_ALREADY_EXISTS',
        `${this.entityType} ${id} version ${version} already exists — versions are append-only and cannot be overwritten`,
      );
    }
    const now = this.clock.now().toISOString();
    const record = {
      ...data,
      version,
      created_at: now,
      updated_at: now,
      status: 'active',
    } as T;
    await this.store.put(key, record);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: this.entityType,
        entityId: key,
      }),
    );
    return unprojected(record);
  }

  async getVersion(id: string, version: number): Promise<Unprojected<T> | undefined> {
    const found = await this.store.get(this.versionKey(id, version));
    return found === undefined ? undefined : unprojected(found);
  }

  /**
   * TASK 3.2.2: every version, oldest first (`getVersion(id, 1)`,
   * `getVersion(id, 2)`, …, stopping at the first gap). The simplest
   * correct implementation for a low-version-count entity — a clinician
   * revises a diagnosis or care plan occasionally, not thousands of times
   * — and one method every future versioned entity benefits from, not a
   * bespoke query in whichever handler reads first. Relies on the same
   * no-gaps assumption `docs/runbooks/clinical-record.md`'s TASK 3.2.1
   * section already names as an accepted, documented limit of the
   * caller-supplied version number: a version created out of sequence
   * (e.g. `3` before `1`/`2` exist) would end this list early rather than
   * skip the gap.
   */
  async listVersions(id: string): Promise<Unprojected<T>[]> {
    const versions: Unprojected<T>[] = [];
    let version = 1;
    for (;;) {
      const found = await this.getVersion(id, version);
      if (!found) {
        return versions;
      }
      versions.push(found);
      version += 1;
    }
  }

  private versionKey(id: string, version: number): string {
    return `${id}#v${version}`;
  }
}
