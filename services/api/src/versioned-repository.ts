// TASK 0.3.3's versioned-record helper, for docs/plan/04-data-model-rbac.md's
// "Versioned, append-only" entities (diagnosis, care plan, assessment
// forms): each version is its own immutable key, so version N+1 can never
// mutate version N, and writing an already-existing version throws instead
// of silently overwriting it.
import type { AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import type { KeyValueStore } from './store.js';
import type { BaseRecord } from './types.js';

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
    actor: string,
    data: Omit<T, keyof BaseRecord | 'version'>,
  ): Promise<T> {
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
    await this.audit.write({
      at: now,
      actor,
      action: 'create',
      entityType: this.entityType,
      entityId: key,
    });
    return record;
  }

  async getVersion(id: string, version: number): Promise<T | undefined> {
    return this.store.get(this.versionKey(id, version));
  }

  private versionKey(id: string, version: number): string {
    return `${id}#v${version}`;
  }
}
