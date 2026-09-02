// TASK 1.5.1: docs/plan/04-data-model-rbac.md-style entity —
// `PK = WORKSHOP#<id>` / `SK = META`. Workshop's status
// (draft|published|cancelled, packages/shared-types/src/workshop.ts) is
// never 'deleted', same discipline content-repository.ts's ContentItem and
// testimonial-repository.ts's Testimonial follow — so this is a bespoke
// repository, not `Repository<T>`.
//
// `WorkshopStore.listAllIds()` is projected onto GSI2 the same fixed,
// status-independent way testimonial-repository.ts's "all testimonials"
// row is — one row per workshop, written once at creation, never touched
// again. Filtering by status *and* by "hasn't happened yet" both happen in
// application code after a GetItem per id, for the same reason
// testimonial-repository.ts gives for avoiding a status-keyed GSI2 row:
// DeleteItem is unavailable to this store, so a stale status- or date-keyed
// row could never be cleaned up, and a cancelled/past workshop would keep
// resurfacing forever.
import type { Workshop } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';

export interface WorkshopStore {
  get(id: string): Promise<Workshop | undefined>;
  /** Atomically writes the main item and its GSI2 "all workshops" projection row. Throws AppError('RECORD_ALREADY_EXISTS', ...) if `item.id` already exists. */
  create(item: Workshop): Promise<void>;
  /** Overwrites the main item. Never removes it — see this file's own header comment. */
  update(item: Workshop): Promise<void>;
  /** Every workshop id ever created, in no particular order. */
  listAllIds(): Promise<string[]>;
}

export class InMemoryWorkshopStore implements WorkshopStore {
  private readonly items = new Map<string, Workshop>();

  async get(id: string): Promise<Workshop | undefined> {
    return this.items.get(id);
  }

  async create(item: Workshop): Promise<void> {
    if (this.items.has(item.id)) {
      throw new AppError('RECORD_ALREADY_EXISTS', `workshop ${item.id} already exists`);
    }
    this.items.set(item.id, item);
  }

  async update(item: Workshop): Promise<void> {
    this.items.set(item.id, item);
  }

  async listAllIds(): Promise<string[]> {
    return [...this.items.keys()];
  }
}

export type CreateWorkshopInput = Omit<Workshop, 'created_at' | 'updated_at'>;

/** Patchable by TASK 1.5.1's `PATCH /workshops/:id` — never `status` (publish/cancel own that transition exclusively, same discipline as content/testimonials). */
export type UpdateWorkshopInput = Partial<
  Pick<Workshop, 'dateTimeUtc' | 'capacity' | 'priceMinorUnits' | 'posterKey' | 'details'>
>;

export class WorkshopRepository {
  constructor(
    private readonly store: WorkshopStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async create(actor: ActorContext, data: CreateWorkshopInput): Promise<Workshop> {
    const now = this.clock.now().toISOString();
    const item: Workshop = { ...data, created_at: now, updated_at: now };
    await this.store.create(item);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: 'Workshop',
        entityId: item.id,
      }),
    );
    return item;
  }

  async findById(id: string): Promise<Workshop | undefined> {
    return this.store.get(id);
  }

  /** Only ever returns published, not-yet-happened workshops — the public read boundary the public pages rely on. A cancelled or past workshop's row stays findById-able (still never deleted). */
  /**
   * Every workshop, whatever its status and whenever it is — the authoring
   * side's own view. Separate from `findPublishedUpcoming` for the reason
   * `ContentRepository.findAllByKeyword` states: the published filter is a
   * boundary, not an option.
   */
  async findAll(): Promise<Workshop[]> {
    const ids = await this.store.listAllIds();
    const items = await Promise.all(ids.map((id) => this.store.get(id)));
    return items.filter((item): item is Workshop => item !== undefined);
  }

  async findPublishedUpcoming(): Promise<Workshop[]> {
    const ids = await this.store.listAllIds();
    const items = await Promise.all(ids.map((id) => this.store.get(id)));
    const nowIso = this.clock.now().toISOString();
    return items.filter(
      (item): item is Workshop => item?.status === 'published' && item.dateTimeUtc >= nowIso,
    );
  }

  /**
   * Edits schedule/capacity/price/poster/details only — never `status`
   * (00-conventions.md's no-delete rule extends here too: this is not how a
   * workshop is cancelled, see publish/cancel below). Throws
   * AppError('RECORD_NOT_FOUND') if `id` doesn't exist.
   */
  async update(actor: ActorContext, id: string, patch: UpdateWorkshopInput): Promise<Workshop> {
    const existing = await this.requireExists(id);
    const now = this.clock.now().toISOString();
    const record: Workshop = {
      ...existing,
      ...patch,
      status: existing.status,
      created_at: existing.created_at,
      updated_at: now,
    };
    await this.store.update(record);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'update',
        entityType: 'Workshop',
        entityId: id,
      }),
    );
    return record;
  }

  /** Transitions `status` to 'published'. Never removes the row. */
  async publish(actor: ActorContext, id: string): Promise<Workshop> {
    return this.transitionStatus(actor, id, 'published', 'publish');
  }

  /**
   * Transitions `status` to 'cancelled'. This is the *only* effect — a
   * cancelled workshop's row and poster remain retrievable, and it's
   * simply excluded from `findPublishedUpcoming`.
   */
  async cancel(actor: ActorContext, id: string): Promise<Workshop> {
    return this.transitionStatus(actor, id, 'cancelled', 'cancel');
  }

  private async transitionStatus(
    actor: ActorContext,
    id: string,
    status: Workshop['status'],
    action: 'publish' | 'cancel',
  ): Promise<Workshop> {
    const existing = await this.requireExists(id);
    const now = this.clock.now().toISOString();
    const record: Workshop = { ...existing, status, updated_at: now };
    await this.store.update(record);
    await this.audit.write(
      auditEventFor(actor, { at: now, action, entityType: 'Workshop', entityId: id }),
    );
    return record;
  }

  private async requireExists(id: string): Promise<Workshop> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `workshop ${id} not found`);
    }
    return existing;
  }
}

// TASK 1.5.1 step 5: "Public listing/detail pages render published,
// non-past workshops" — one public, unauthenticated, flag-gated read
// endpoint, same shape as content-repository.ts's createContentReadHandler.
// Unlike content, there's no keyword filter: apps/web's workshops pages
// (index and per-workshop detail, both built at `astro build` time per
// ADR-0017) fetch this single list and do their own per-locale/per-id
// filtering, the same way apps/web/src/blog/[slug].astro already does for
// content.
const WORKSHOP_READ_LOG_SAMPLE_RATE = 0.1;

export interface WorkshopReadDeps {
  readonly repository: WorkshopRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createWorkshopReadHandler(deps: WorkshopReadDeps): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: WORKSHOP_READ_LOG_SAMPLE_RATE });

  return async (event) => {
    const start = clock.now();

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: '/workshops',
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // Flag: workshops.enabled — default off, same "invisible until ready"
    // convention as content.readApi.enabled/testimonials.submission.enabled.
    if (!(await deps.flags.isEnabled('workshops.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const items = await deps.repository.findPublishedUpcoming();
    return respond(200, { items });
  };
}
