// TASK 0.3.3: repository base class enforcing created_at/updated_at/status
// on every write, backed by an append-only audit writer. "Delete" is
// softDelete — it flips status to 'deleted' and the record stays readable
// by findById. No method here removes an item from the store (00-conventions.md's
// prohibition; docs/plan/05-execution-plan.md TASK 0.3.3's DoD: "no
// repository method exists that removes a row").
import type { AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import type { KeyValueStore } from './store.js';
import type { BaseRecord } from './types.js';

export class Repository<T extends BaseRecord> {
  constructor(
    private readonly store: KeyValueStore<T>,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
    private readonly entityType: string,
  ) {}

  async create(id: string, actor: string, data: Omit<T, keyof BaseRecord>): Promise<T> {
    const existing = await this.store.get(id);
    if (existing) {
      throw new AppError('RECORD_ALREADY_EXISTS', `${this.entityType} ${id} already exists`);
    }
    const now = this.clock.now().toISOString();
    const record = {
      ...data,
      created_at: now,
      updated_at: now,
      status: 'active',
    } as T;
    await this.store.put(id, record);
    await this.audit.write({
      at: now,
      actor,
      action: 'create',
      entityType: this.entityType,
      entityId: id,
    });
    return record;
  }

  async update(id: string, actor: string, patch: Partial<Omit<T, keyof BaseRecord>>): Promise<T> {
    const existing = await this.requireActive(id);
    const now = this.clock.now().toISOString();
    const record: T = {
      ...existing,
      ...patch,
      created_at: existing.created_at,
      updated_at: now,
      status: existing.status,
    };
    await this.store.put(id, record);
    await this.audit.write({
      at: now,
      actor,
      action: 'update',
      entityType: this.entityType,
      entityId: id,
    });
    return record;
  }

  async softDelete(id: string, actor: string): Promise<T> {
    const existing = await this.requireActive(id);
    const now = this.clock.now().toISOString();
    const record: T = { ...existing, status: 'deleted', updated_at: now };
    await this.store.put(id, record);
    await this.audit.write({
      at: now,
      actor,
      action: 'soft-delete',
      entityType: this.entityType,
      entityId: id,
    });
    return record;
  }

  async findById(id: string): Promise<T | undefined> {
    return this.store.get(id);
  }

  private async requireActive(id: string): Promise<T> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `${this.entityType} ${id} not found`);
    }
    if (existing.status !== 'active') {
      throw new AppError(
        'RECORD_NOT_ACTIVE',
        `${this.entityType} ${id} is not active (status: ${existing.status})`,
      );
    }
    return existing;
  }
}
