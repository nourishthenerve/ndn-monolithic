// TASK 2.4.1: the clinician directory's data layer — a bespoke store, not
// `Repository<T>` (0.3.3's generic base), because "exactly one principal
// may exist" (step 7) needs an atomic multi-item write the same shape
// content-repository.ts/testimonial-repository.ts already use for their
// own invariants: a main row plus a marker/projection row, one
// `TransactWriteItems`, one `attribute_not_exists` condition per row.
//
// **Ordering note, and where this deliberately diverges from the task's
// own stated step 2.** The task's text says the `CLI#` record is written
// *before* `AdminCreateUser`, "so an orphaned Cognito user is the failure
// mode rather than an orphaned record." TASK 2.2.2's principal directory
// (dynamo-principal-directory.ts) already settled this differently, and
// first: the `CLI#` record is keyed by the Cognito `sub` — the same
// decision `PAT#` records made — and at the moment a record would be
// written before `AdminCreateUser` runs, there is no `sub` yet to key it
// by. That file's own header states the resolution: "call AdminCreateUser
// first, then write CLI#<sub>", and that the original reason survives the
// reordering — an orphaned Cognito user with no `CLI#` row is exactly what
// `PrincipalDirectory.lookup` already treats as unauthorisable, denying it
// cleanly rather than crashing on it. This file and
// clinician-admin-handler.ts follow that settled ordering, not the task
// text's original one.
//
// This repository is deliberately silent on Cognito — it knows nothing
// about `AdminCreateUser`/`AdminDisableUser`/`AdminEnableUser`. Those are
// clinician-admin-handler.ts's job, the same split patient-admin.ts
// (SDK-free) keeps from patient-admin-handler.ts (SDK wiring).
import type { Clinician, ClinicianRole } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';

export const CLINICIAN_ENTITY_TYPE = 'clinician';

export interface ClinicianStore {
  get(id: string): Promise<Clinician | undefined>;
  /**
   * Atomically writes the `CLI#<id>` row and, when `item.role ===
   * 'principal'`, a singleton marker row alongside it in the same
   * transaction. Throws `AppError('RECORD_ALREADY_EXISTS', ...)` on an id
   * collision, `AppError('PRINCIPAL_ALREADY_EXISTS', ...)` if a principal
   * already exists and `item.role === 'principal'`. **This is the
   * repository's own enforcement of step 7's "exactly one principal", not
   * a check the handler performs** — and it is race-free: two concurrent
   * creates can both pass an in-app check; only one can win a conditional
   * write.
   */
  create(item: Clinician): Promise<void>;
  /** Plain overwrite — deactivate/reactivate. Callers never change `role` through this. */
  update(item: Clinician): Promise<void>;
}

export class InMemoryClinicianStore implements ClinicianStore {
  private readonly items = new Map<string, Clinician>();
  private principalId: string | undefined;

  async get(id: string): Promise<Clinician | undefined> {
    return this.items.get(id);
  }

  async create(item: Clinician): Promise<void> {
    if (this.items.has(item.id)) {
      throw new AppError('RECORD_ALREADY_EXISTS', `clinician ${item.id} already exists`);
    }
    if (item.role === 'principal' && this.principalId !== undefined) {
      throw new AppError('PRINCIPAL_ALREADY_EXISTS', 'a principal clinician already exists');
    }
    this.items.set(item.id, item);
    if (item.role === 'principal') {
      this.principalId = item.id;
    }
  }

  async update(item: Clinician): Promise<void> {
    this.items.set(item.id, item);
  }
}

export interface CreateClinicianInput {
  readonly displayName: string;
  readonly role: ClinicianRole;
}

export class ClinicianRepository {
  constructor(
    private readonly store: ClinicianStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * `id` is the Cognito `sub` the caller already obtained from
   * `AdminCreateUser` — see this file's header. Always created `active`:
   * a clinician the principal just invited has an operative account from
   * the moment it exists — there is no clinician equivalent of a patient's
   * `pending`, because the principal creating them *is* the approval.
   */
  async create(id: string, input: CreateClinicianInput, actor: ActorContext): Promise<Clinician> {
    const now = this.clock.now().toISOString();
    const record: Clinician = {
      id,
      displayName: input.displayName,
      role: input.role,
      account_status: 'active',
      status: 'active',
      created_at: now,
      updated_at: now,
    };
    await this.store.create(record);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: CLINICIAN_ENTITY_TYPE,
        entityId: id,
      }),
    );
    return record;
  }

  /** Still readable in every status — a deactivated clinician's name still resolves on every past record. */
  async findById(id: string): Promise<Clinician | undefined> {
    return this.store.get(id);
  }

  /**
   * Sets `account_status: 'deactivated'`. The Cognito-side disable and
   * token revocation are clinician-admin-handler.ts's job — see this
   * file's header for the split, and the task's step 4 for why all three
   * (record, `AdminDisableUser`, token revocation) matter independently.
   */
  async deactivate(id: string, actor: ActorContext): Promise<Clinician> {
    return this.transition(id, 'deactivated', actor);
  }

  async reactivate(id: string, actor: ActorContext): Promise<Clinician> {
    return this.transition(id, 'active', actor);
  }

  private async transition(
    id: string,
    account_status: Clinician['account_status'],
    actor: ActorContext,
  ): Promise<Clinician> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `clinician ${id} not found`);
    }
    const now = this.clock.now().toISOString();
    // `role` is untouched on purpose — step 7: role transfer is "a
    // distinct, audited operation, never an implicit side effect" of
    // anything this method does.
    const record: Clinician = { ...existing, account_status, updated_at: now };
    await this.store.update(record);
    await this.audit.write(
      auditEventFor(actor, { at: now, action: 'update', entityType: CLINICIAN_ENTITY_TYPE, entityId: id }),
    );
    return record;
  }
}
