// TASK 1.5.2: docs/plan/04-data-model-rbac.md-style entity —
// `PK = WORKSHOP#<id>` / `SK = REGISTRATION#<id>`. Registration's status
// (pending|confirmed|cancelled, packages/shared-types/src/registration.ts)
// is never 'deleted', same discipline as Workshop/ContentItem/Testimonial —
// so this is a bespoke repository, not `Repository<T>`.
//
// Capacity is tracked in a *separate* row (`WORKSHOP#<id>` / `CAPACITY`),
// deliberately not a `registeredCount` attribute on the Workshop's own
// `META` row: WorkshopRepository.update() (workshop-repository.ts) does a
// plain read-modify-write overwrite of that row when an admin edits
// schedule/capacity/price/poster/details, and interleaving that with this
// store's atomic `UpdateItem` increments would create a lost-update race
// (an admin edit landing between this store's read-implicit
// increment/decrement and the admin's own overwrite could silently revert
// a concurrent reservation). A dedicated row makes the two paths
// non-overlapping by construction, mirroring 0.5.3's SpendCounterStore —
// same atomic "conditional update, no read-then-write gap" shape, keyed by
// workshop id instead of a month.
import type { Registration, RegistrationStatus } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';

export interface RegistrationStore {
  get(workshopId: string, id: string): Promise<Registration | undefined>;
  /** Throws AppError('RECORD_ALREADY_EXISTS', ...) if `item.id` already exists under `item.workshopId`. */
  create(item: Registration): Promise<void>;
  /** Overwrites the row. Never removes it. */
  update(item: Registration): Promise<void>;
}

export class InMemoryRegistrationStore implements RegistrationStore {
  private readonly items = new Map<string, Registration>();

  private key(workshopId: string, id: string): string {
    return `${workshopId}#${id}`;
  }

  async get(workshopId: string, id: string): Promise<Registration | undefined> {
    return this.items.get(this.key(workshopId, id));
  }

  async create(item: Registration): Promise<void> {
    const key = this.key(item.workshopId, item.id);
    if (this.items.has(key)) {
      throw new AppError('RECORD_ALREADY_EXISTS', `registration ${item.id} already exists`);
    }
    this.items.set(key, item);
  }

  async update(item: Registration): Promise<void> {
    this.items.set(this.key(item.workshopId, item.id), item);
  }
}

export interface WorkshopCapacityStore {
  /**
   * Atomically increments `workshopId`'s reservation count, but only if the
   * result would not exceed `capacity`. Returns whether the reservation was
   * committed; on a `false` return, no state changed — same "never
   * partially apply" guarantee as 0.5.3's SpendCounterStore.tryAdd.
   */
  tryReserve(workshopId: string, capacity: number): Promise<boolean>;
  /** Atomically decrements `workshopId`'s reservation count by one, never below zero. A release with nothing to release is a no-op, not an error. */
  release(workshopId: string): Promise<void>;
}

export class InMemoryWorkshopCapacityStore implements WorkshopCapacityStore {
  private readonly counts = new Map<string, number>();

  // No `await` between the read and the write below — same reasoning
  // sms-spend-cap.ts's InMemorySpendCounterStore documents: every call runs
  // its check-then-commit to completion before the next queued call starts,
  // faithfully modelling the atomicity a real DynamoDB conditional update
  // gives under concurrency.
  async tryReserve(workshopId: string, capacity: number): Promise<boolean> {
    const current = this.counts.get(workshopId) ?? 0;
    if (current >= capacity) return false;
    this.counts.set(workshopId, current + 1);
    return true;
  }

  async release(workshopId: string): Promise<void> {
    const current = this.counts.get(workshopId) ?? 0;
    this.counts.set(workshopId, Math.max(0, current - 1));
  }
}

export type CreateRegistrationInput = Pick<
  Registration,
  'id' | 'workshopId' | 'attendeeEmail' | 'stripeCheckoutSessionId'
>;

export class RegistrationRepository {
  constructor(
    private readonly store: RegistrationStore,
    private readonly capacity: WorkshopCapacityStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Atomically reserves one capacity slot against `capacity` (the
   * workshop's own limit, read by the caller before this call). Must be
   * paired with either `create()` on success or `releaseCapacity()` if the
   * caller can't complete the registration (e.g. the Stripe API call that
   * was meant to follow this reservation fails) — see stripe-checkout.ts.
   */
  async reserveCapacity(workshopId: string, capacity: number): Promise<boolean> {
    return this.capacity.tryReserve(workshopId, capacity);
  }

  async releaseCapacity(workshopId: string): Promise<void> {
    await this.capacity.release(workshopId);
  }

  /** Always creates as 'pending' — a registration only ever becomes 'confirmed' via the Stripe webhook. */
  async create(actor: ActorContext, data: CreateRegistrationInput): Promise<Registration> {
    const now = this.clock.now().toISOString();
    const item: Registration = { ...data, status: 'pending', created_at: now, updated_at: now };
    await this.store.create(item);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: 'Registration',
        entityId: item.id,
      }),
    );
    return item;
  }

  async findById(workshopId: string, id: string): Promise<Registration | undefined> {
    return this.store.get(workshopId, id);
  }

  /**
   * Transitions a 'pending' registration to 'confirmed'. A no-op (returns
   * the existing record unchanged, no audit write) if it isn't 'pending' —
   * guards a confirm arriving after the registration was already cancelled
   * (or an already-confirmed one, though stripe-webhook.ts's own event-id
   * idempotency gate is what normally prevents that from being reached
   * twice).
   */
  async confirm(actor: ActorContext, workshopId: string, id: string): Promise<Registration> {
    const existing = await this.requireExists(workshopId, id);
    if (existing.status !== 'pending') {
      return existing;
    }
    return this.transitionStatus(actor, existing, 'confirmed');
  }

  /**
   * Transitions a 'pending' registration to 'cancelled' and releases its
   * capacity reservation. A no-op (no capacity released either) if it
   * isn't 'pending' — an already-'confirmed' registration's slot was
   * already spent, not reclaimable by a late `checkout.session.expired`.
   */
  async cancel(actor: ActorContext, workshopId: string, id: string): Promise<Registration> {
    const existing = await this.requireExists(workshopId, id);
    if (existing.status !== 'pending') {
      return existing;
    }
    const record = await this.transitionStatus(actor, existing, 'cancelled');
    await this.capacity.release(workshopId);
    return record;
  }

  private async transitionStatus(
    actor: ActorContext,
    existing: Registration,
    status: RegistrationStatus,
  ): Promise<Registration> {
    const now = this.clock.now().toISOString();
    const record: Registration = { ...existing, status, updated_at: now };
    await this.store.update(record);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: status === 'confirmed' ? 'confirm' : 'cancel',
        entityType: 'Registration',
        entityId: record.id,
      }),
    );
    return record;
  }

  private async requireExists(workshopId: string, id: string): Promise<Registration> {
    const existing = await this.store.get(workshopId, id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `registration ${id} not found`);
    }
    return existing;
  }
}
