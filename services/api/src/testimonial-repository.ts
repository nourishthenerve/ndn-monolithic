// TASK 1.4.2: docs/plan/04-data-model-rbac.md-style entity —
// `PK = TESTIMONIAL#<id>` / `SK = META`. Testimonial's status
// (pending_review|published|rejected, packages/shared-types/src/testimonial.ts)
// is never 'deleted', same discipline content-repository.ts's ContentItem
// follows — so this is a bespoke repository, not `Repository<T>`.
//
// `TestimonialStore.listAllIds()` is projected onto GSI2 the same way
// content-repository.ts's `withContentTypeKeyword` lists every blog post by
// its own contentType: one fixed, status-independent projection row per
// testimonial, written once at creation and never touched again. Filtering
// by status happens in application code after a GetItem per id (see
// findPublished/findPendingReview below) — deliberately *not* a
// status-keyed GSI2 row, because DeleteItem is unavailable to this store
// (00-conventions.md's no-delete rule) and a status-keyed row would go
// stale forever the moment a testimonial's status changed (an already-
// published testimonial would keep showing up in a "pending_review" query).
// A fixed entity-type projection never has this problem, exactly like
// content's own "blog" keyword never changes after creation.
//
// Unlike content-repository.ts, the HTTP read boundary isn't embedded here:
// `GET /testimonials` overloads one path for two audiences (an
// unauthenticated visitor gets published testimonials; an admin passing
// `?status=pending_review` gets the moderation queue) per TASK 1.4.2 step
// 4, which HttpApi can only route to a single Lambda integration — so both
// behaviours live together in testimonial-moderation.ts instead.
import type { Testimonial } from '@ndn/shared-types';

import type { AuditWriter } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';

export interface TestimonialStore {
  get(id: string): Promise<Testimonial | undefined>;
  /** Atomically writes the main item and its GSI2 "all testimonials" projection row. Throws AppError('RECORD_ALREADY_EXISTS', ...) if `item.id` already exists. */
  create(item: Testimonial): Promise<void>;
  /**
   * Overwrites the main item. `item.consent` must equal the currently
   * stored value — TASK 1.4.2's own DoD: "a second write attempt to an
   * existing consent object throws rather than overwriting." Every real
   * caller (publish/reject below) only ever echoes `consent` back
   * unchanged, so this only ever fires if a future bug tries to touch it.
   */
  update(item: Testimonial): Promise<void>;
  /** Every testimonial id ever created, in no particular order. */
  listAllIds(): Promise<string[]>;
}

function consentsMatch(a: Testimonial['consent'], b: Testimonial['consent']): boolean {
  return (
    a.textVersion === b.textVersion &&
    a.consentedAt === b.consentedAt &&
    a.submitterContactHash === b.submitterContactHash
  );
}

export class InMemoryTestimonialStore implements TestimonialStore {
  private readonly items = new Map<string, Testimonial>();

  async get(id: string): Promise<Testimonial | undefined> {
    return this.items.get(id);
  }

  async create(item: Testimonial): Promise<void> {
    if (this.items.has(item.id)) {
      throw new AppError('RECORD_ALREADY_EXISTS', `testimonial ${item.id} already exists`);
    }
    this.items.set(item.id, item);
  }

  async update(item: Testimonial): Promise<void> {
    const existing = this.items.get(item.id);
    if (existing && !consentsMatch(existing.consent, item.consent)) {
      throw new AppError(
        'CONSENT_IMMUTABLE',
        `testimonial ${item.id} consent is immutable once recorded`,
      );
    }
    this.items.set(item.id, item);
  }

  async listAllIds(): Promise<string[]> {
    return [...this.items.keys()];
  }
}

export type SubmitTestimonialInput = Pick<Testimonial, 'id' | 'quote' | 'attribution'> & {
  consent: Omit<Testimonial['consent'], 'consentedAt'>;
};

export class TestimonialRepository {
  constructor(
    private readonly store: TestimonialStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /** Always creates as 'pending_review' — a testimonial only ever becomes visible via an admin's explicit publish. */
  async submit(actor: string, data: SubmitTestimonialInput): Promise<Testimonial> {
    const now = this.clock.now().toISOString();
    const item: Testimonial = {
      ...data,
      status: 'pending_review',
      consent: { ...data.consent, consentedAt: now },
      created_at: now,
      updated_at: now,
    };
    await this.store.create(item);
    await this.audit.write({
      at: now,
      actor,
      action: 'create',
      entityType: 'Testimonial',
      entityId: item.id,
    });
    return item;
  }

  async findById(id: string): Promise<Testimonial | undefined> {
    return this.store.get(id);
  }

  /** Only ever returns published testimonials — the public read boundary the public page relies on. */
  async findPublished(): Promise<Testimonial[]> {
    return this.findByStatus('published');
  }

  /** The moderation queue: every testimonial awaiting a decision. */
  async findPendingReview(): Promise<Testimonial[]> {
    return this.findByStatus('pending_review');
  }

  /** Transitions `status` to 'published'. Never removes the row. */
  async publish(actor: string, id: string): Promise<Testimonial> {
    return this.transitionStatus(actor, id, 'published', 'publish');
  }

  /**
   * Transitions `status` to 'rejected'. This is the *only* effect — a
   * rejected testimonial stays `findById`-able and admin-visible, and is
   * never public.
   */
  async reject(actor: string, id: string): Promise<Testimonial> {
    return this.transitionStatus(actor, id, 'rejected', 'reject');
  }

  private async findByStatus(status: Testimonial['status']): Promise<Testimonial[]> {
    const ids = await this.store.listAllIds();
    const items = await Promise.all(ids.map((id) => this.store.get(id)));
    return items.filter((item): item is Testimonial => item?.status === status);
  }

  private async transitionStatus(
    actor: string,
    id: string,
    status: Testimonial['status'],
    action: 'publish' | 'reject',
  ): Promise<Testimonial> {
    const existing = await this.requireExists(id);
    const now = this.clock.now().toISOString();
    const record: Testimonial = { ...existing, status, updated_at: now };
    await this.store.update(record);
    await this.audit.write({ at: now, actor, action, entityType: 'Testimonial', entityId: id });
    return record;
  }

  private async requireExists(id: string): Promise<Testimonial> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `testimonial ${id} not found`);
    }
    return existing;
  }
}
