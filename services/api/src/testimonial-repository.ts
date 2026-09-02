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
import { createHash } from 'node:crypto';

import type { Testimonial } from '@ndn/shared-types';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
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

/**
 * The record id for a patient's testimonial — a SHA-256 of their patient
 * id, hex.
 *
 * **This is where "maximum one per patient" lives.** Not a uniqueness
 * check in a handler, not a conditional write, not a GSI lookup: the
 * address of the record is a function of its author, so a second
 * submission is the same record written twice. There is no code path that
 * creates a patient's second testimonial, because there is no second
 * address to create it at.
 *
 * Hashed rather than the patient id itself for one reason: the id lives in
 * a `TESTIMONIAL#<id>` partition key that appears in logs, metrics and
 * error messages, and a raw patient id in that position is a patient
 * identifier in every one of them. The public read never returns it at all
 * (`testimonial-moderation.ts` projects it away), so the hash needs to
 * resist nothing stronger than incidental exposure — but it costs one line
 * and removes the question.
 */
export function testimonialIdForPatient(patientId: string): string {
  return createHash('sha256').update(patientId).digest('hex');
}

export type SubmitTestimonialInput = Pick<Testimonial, 'quote' | 'attribution'> & {
  readonly authorPatientId: string;
  readonly consentTextVersion: string;
};

export class TestimonialRepository {
  constructor(
    private readonly store: TestimonialStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  /**
   * Create-or-replace a patient's single testimonial, published.
   *
   * **Published on write, with no review step**, per the owner: *"there is
   * no concept of review a testimonial — it should go live as soon as
   * patient submits it from his account."* The review this replaces
   * existed because the author was an anonymous stranger; a signed-in
   * patient writing about their own care is not a submission that needs
   * vetting before the practice will stand behind it.
   *
   * Consent is stamped once, on first write, and carried forward
   * unchanged by every edit — `consentedAt` records when the patient
   * agreed to be published, which an edit does not change. Withdrawal is
   * how that agreement is revoked.
   */
  async upsertForPatient(actor: ActorContext, data: SubmitTestimonialInput): Promise<Testimonial> {
    const id = testimonialIdForPatient(data.authorPatientId);
    const now = this.clock.now().toISOString();
    const existing = await this.store.get(id);
    const record: Testimonial = {
      id,
      authorPatientId: data.authorPatientId,
      quote: data.quote,
      attribution: data.attribution,
      status: 'published',
      consent: existing?.consent ?? {
        textVersion: data.consentTextVersion,
        consentedAt: now,
      },
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    if (existing) {
      await this.store.update(record);
    } else {
      await this.store.create(record);
    }
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: existing ? 'update' : 'create',
        entityType: 'Testimonial',
        entityId: id,
      }),
    );
    return record;
  }

  async findById(id: string): Promise<Testimonial | undefined> {
    return this.store.get(id);
  }

  /**
   * A patient's own testimonial, whatever its status — including a
   * withdrawn one, so the account page can offer to put it back rather
   * than silently starting them over on a record that still exists.
   */
  async findForPatient(patientId: string): Promise<Testimonial | undefined> {
    return this.store.get(testimonialIdForPatient(patientId));
  }

  /** Only ever returns published testimonials — the public read boundary the public page relies on. */
  async findPublished(): Promise<Testimonial[]> {
    return this.findByStatus('published');
  }

  /**
   * Transitions a patient's own testimonial to `withdrawn`.
   *
   * Never removes the row (00-conventions.md), and deliberately keeps the
   * quote: the patient may put it back, and a withdrawal that destroyed
   * the text would make "undo" into "write it again from memory".
   *
   * Takes the patient id rather than a record id, so there is no
   * parameter through which one patient could name another's testimonial.
   */
  async withdrawForPatient(actor: ActorContext, patientId: string): Promise<Testimonial> {
    const id = testimonialIdForPatient(patientId);
    const existing = await this.requireExists(id);
    const now = this.clock.now().toISOString();
    const record: Testimonial = { ...existing, status: 'withdrawn', updated_at: now };
    await this.store.update(record);
    await this.audit.write(
      auditEventFor(actor, { at: now, action: 'withdraw', entityType: 'Testimonial', entityId: id }),
    );
    return record;
  }

  private async findByStatus(status: Testimonial['status']): Promise<Testimonial[]> {
    const ids = await this.store.listAllIds();
    const items = await Promise.all(ids.map((id) => this.store.get(id)));
    return items.filter((item): item is Testimonial => item?.status === status);
  }

  private async requireExists(id: string): Promise<Testimonial> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `testimonial ${id} not found`);
    }
    return existing;
  }
}
