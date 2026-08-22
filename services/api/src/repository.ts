// TASK 0.3.3: repository base class enforcing created_at/updated_at/status
// on every write, backed by an append-only audit writer. "Delete" is
// softDelete — it flips status to 'deleted' and the record stays readable
// by findById. No method here removes an item from the store (00-conventions.md's
// prohibition; docs/plan/05-execution-plan.md TASK 0.3.3's DoD: "no
// repository method exists that removes a row").
//
// TASK 2.1.3: `actor` is an `ActorContext` (audit.ts), not a bare string.
// Every write already had to say who; now it has to say with what role and
// from where too, because docs/plan/04-data-model-rbac.md has asked for
// who/what/when/**where** since the plan was committed and the audit type
// only ever carried the first three. Making it a parameter rather than
// something a writer decorates on later means a caller that cannot say
// where a write came from does not compile.
//
// TASK 2.1.2 (R-09): every method that hands a record back marks it
// `Unprojected<T>` (projection.ts). docs/plan/04-data-model-rbac.md puts
// the clinician-private boundary "at the repository layer — not in the
// handler, not in the view", and this is the repository's half of it: what
// leaves here is visibly a record with its `private{}` half intact, and
// `serialiseResponse` will not take one until `projectFor` has ruled on it.
// Writes are branded as well as reads — a freshly created record echoed
// straight back to its author is exactly the "forgot to project" bug the
// brand exists to catch.
import type { BaseRecord } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { unprojected, type Unprojected } from './projection.js';
import type { KeyValueStore } from './store.js';

export class Repository<T extends BaseRecord> {
  constructor(
    private readonly store: KeyValueStore<T>,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
    private readonly entityType: string,
  ) {}

  async create(
    id: string,
    actor: ActorContext,
    data: Omit<T, keyof BaseRecord>,
  ): Promise<Unprojected<T>> {
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
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: this.entityType,
        entityId: id,
      }),
    );
    return unprojected(record);
  }

  async update(
    id: string,
    actor: ActorContext,
    patch: Partial<Omit<T, keyof BaseRecord>>,
  ): Promise<Unprojected<T>> {
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
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'update',
        entityType: this.entityType,
        entityId: id,
      }),
    );
    return unprojected(record);
  }

  async softDelete(id: string, actor: ActorContext): Promise<Unprojected<T>> {
    const existing = await this.requireActive(id);
    const now = this.clock.now().toISOString();
    const record: T = { ...existing, status: 'deleted', updated_at: now };
    await this.store.put(id, record);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'soft-delete',
        entityType: this.entityType,
        entityId: id,
      }),
    );
    return unprojected(record);
  }

  async findById(id: string): Promise<Unprojected<T> | undefined> {
    const found = await this.store.get(id);
    return found === undefined ? undefined : unprojected(found);
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
