// TASK 1.3.1: docs/plan/04-data-model-rbac.md's content entity —
// `PK = CONTENT#<id>` / `SK = META`. ContentItem's status
// (draft|published|unpublished, packages/shared-types/src/content.ts) is
// domain-specific and never 'deleted' (00-conventions.md's no-delete rule),
// which doesn't fit Repository<T>'s active|deleted lifecycle
// (repository.ts hardcodes `status: 'active'` on create and rejects
// anything but 'active' as "not active") — so this is a bespoke repository,
// not `Repository<ContentItem>`. TASK 1.3.2's publish/unpublish endpoints
// build on ContentStore/ContentRepository below rather than reusing 0.3.3's
// generic status.
//
// `keywords[]` are projected onto GSI2 (keyword -> content,
// docs/plan/04-data-model-rbac.md) as separate rows, one per keyword — a
// single item can only carry one value per GSI partition-key attribute, so
// "discoverable by all N keywords" needs N extra rows. `ContentStore.create`
// writes the main item and every keyword row atomically (DynamoContentStore,
// dynamo-store.ts, uses TransactWriteItems; InMemoryContentStore is
// synchronous, so it's atomic by construction) so a content item is never
// half-indexed.
import type { ContentItem } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2 } from 'aws-lambda';

import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';

export interface ContentStore {
  get(id: string): Promise<ContentItem | undefined>;
  /**
   * Atomically writes the main item and one GSI2 projection row per
   * keyword. Throws AppError('RECORD_ALREADY_EXISTS', ...) if `item.id`
   * already exists.
   */
  create(item: ContentItem): Promise<void>;
  /**
   * TASK 1.3.2: overwrites the main item and re-puts (never removes) one
   * GSI2 projection row per keyword `item.keywords` currently lists —
   * including ones already indexed, which is a harmless idempotent rewrite.
   * A keyword dropped from `item.keywords` since the last write keeps its
   * existing GSI2 row: `DeleteItem` is completely unavailable to this store
   * (banned outright by ndn/no-destructive-primitives, no infra/-Deny
   * carve-out like s3:DeleteObject* has — see guardrails.ts and TASK 0.3.1),
   * so a stale projection can only ever be fixed forward, never removed.
   * Assumes `item.id` already exists — callers (ContentRepository.update/
   * publish/unpublish) load-then-write, same division of responsibility as
   * Repository<T>.update/store.put (repository.ts, store.ts).
   */
  update(item: ContentItem): Promise<void>;
  /** Content ids tagged with `keyword`, in no particular order. */
  queryIdsByKeyword(keyword: string): Promise<string[]>;
}

export class InMemoryContentStore implements ContentStore {
  private readonly items = new Map<string, ContentItem>();
  private readonly keywordIndex = new Map<string, Set<string>>();

  async get(id: string): Promise<ContentItem | undefined> {
    return this.items.get(id);
  }

  async create(item: ContentItem): Promise<void> {
    if (this.items.has(item.id)) {
      throw new AppError('RECORD_ALREADY_EXISTS', `content ${item.id} already exists`);
    }
    this.items.set(item.id, item);
    this.indexKeywords(item);
  }

  async update(item: ContentItem): Promise<void> {
    this.items.set(item.id, item);
    this.indexKeywords(item);
  }

  async queryIdsByKeyword(keyword: string): Promise<string[]> {
    return [...(this.keywordIndex.get(keyword) ?? [])];
  }

  private indexKeywords(item: ContentItem): void {
    for (const keyword of item.keywords) {
      const ids = this.keywordIndex.get(keyword) ?? new Set<string>();
      ids.add(item.id);
      this.keywordIndex.set(keyword, ids);
    }
  }
}

export type CreateContentInput = Omit<ContentItem, 'created_at' | 'updated_at'>;

/** Patchable by TASK 1.3.2's `PATCH /content/:id` — never `status` (publish/unpublish own that transition exclusively). */
export type UpdateContentInput = Partial<Pick<ContentItem, 'keywords' | 'translations' | 'imageKey'>>;

// TASK 1.3.2: every item is implicitly discoverable by its own
// `contentType` (e.g. every blog post by the keyword "blog") — reuses
// GSI2's existing keyword -> content projection (TASK 1.3.1) rather than a
// new index or a table Scan, which single-table design reserves for a real
// access pattern GSI (04-data-model-rbac.md: "GSI1/3/4 land with the
// Phase 2/3 tasks that first need them"). This is what lets the public
// site list/build every published post (apps/web's blog pages) with the
// same `GET /content?keyword=` the read API already exposes.
function withContentTypeKeyword(
  keywords: readonly string[],
  contentType: ContentItem['contentType'],
): string[] {
  return keywords.includes(contentType) ? [...keywords] : [...keywords, contentType];
}

export class ContentRepository {
  constructor(
    private readonly store: ContentStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async create(actor: ActorContext, data: CreateContentInput): Promise<ContentItem> {
    const now = this.clock.now().toISOString();
    const item: ContentItem = {
      ...data,
      keywords: withContentTypeKeyword(data.keywords, data.contentType),
      created_at: now,
      updated_at: now,
    };
    await this.store.create(item);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'create',
        entityType: 'Content',
        entityId: item.id,
      }),
    );
    return item;
  }

  async findById(id: string): Promise<ContentItem | undefined> {
    return this.store.get(id);
  }

  /** Only ever returns published content — the public read boundary 1.3.2's read API relies on. */
  async findPublishedByKeyword(keyword: string): Promise<ContentItem[]> {
    const ids = await this.store.queryIdsByKeyword(keyword);
    const items = await Promise.all(ids.map((id) => this.store.get(id)));
    return items.filter((item): item is ContentItem => item?.status === 'published');
  }

  /**
   * Every item under this keyword, **whatever its status** — the authoring
   * side's own view, and deliberately a separate method from the one above
   * rather than a `status` parameter on it. `findPublishedByKeyword` is the
   * public read boundary; a boolean that could turn that boundary off is
   * exactly the shape a mistake takes.
   *
   * 2026-09-02: added because a draft was unreachable. Content saved
   * before the authoring form began publishing by default is `draft`, the
   * public read skips it by design, and nothing in the UI listed it — so
   * work that had been written and saved correctly was invisible and
   * unrecoverable. The route behind this is `Principal`-only.
   */
  async findAllByKeyword(keyword: string): Promise<ContentItem[]> {
    const ids = await this.store.queryIdsByKeyword(keyword);
    const items = await Promise.all(ids.map((id) => this.store.get(id)));
    return items.filter((item): item is ContentItem => item !== undefined);
  }

  /**
   * Edits keywords/translations only — never `status` (00-conventions.md's
   * no-delete rule extends here too: this is not how a post is removed or
   * hidden, see publish/unpublish below). Throws AppError('RECORD_NOT_FOUND')
   * if `id` doesn't exist.
   */
  async update(actor: ActorContext, id: string, patch: UpdateContentInput): Promise<ContentItem> {
    const existing = await this.requireExists(id);
    const now = this.clock.now().toISOString();
    const record: ContentItem = {
      ...existing,
      ...patch,
      keywords: patch.keywords
        ? withContentTypeKeyword(patch.keywords, existing.contentType)
        : existing.keywords,
      status: existing.status,
      created_at: existing.created_at,
      updated_at: now,
    };
    await this.store.update(record);
    await this.audit.write(
      auditEventFor(actor, {
        at: now,
        action: 'update',
        entityType: 'Content',
        entityId: id,
      }),
    );
    return record;
  }

  /** Transitions `status` to 'published'. Never removes the row — see store.update's own comment. */
  async publish(actor: ActorContext, id: string): Promise<ContentItem> {
    return this.transitionStatus(actor, id, 'published', 'publish');
  }

  /**
   * Transitions `status` to 'unpublished'. This is the *only* effect —
   * "unpublish" never calls anything delete-shaped, and the row stays
   * `findById`-able (by id) and admin-visible throughout, even though
   * `findPublishedByKeyword` immediately excludes it.
   */
  async unpublish(actor: ActorContext, id: string): Promise<ContentItem> {
    return this.transitionStatus(actor, id, 'unpublished', 'unpublish');
  }

  private async transitionStatus(
    actor: ActorContext,
    id: string,
    status: ContentItem['status'],
    action: 'publish' | 'unpublish',
  ): Promise<ContentItem> {
    const existing = await this.requireExists(id);
    const now = this.clock.now().toISOString();
    const record: ContentItem = { ...existing, status, updated_at: now };
    await this.store.update(record);
    await this.audit.write(
      auditEventFor(actor, { at: now, action, entityType: 'Content', entityId: id }),
    );
    return record;
  }

  private async requireExists(id: string): Promise<ContentItem> {
    const existing = await this.store.get(id);
    if (!existing) {
      throw new AppError('RECORD_NOT_FOUND', `content ${id} not found`);
    }
    return existing;
  }
}

// TASK 1.3.1 step 5: "Minimal read API only" — GET /content?keyword=.
// Authoring (POST/PATCH/publish/unpublish) is TASK 1.3.2's job; this handler
// never writes.
const CONTENT_READ_LOG_SAMPLE_RATE = 0.1;

export interface ContentReadDeps {
  readonly repository: ContentRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createContentReadHandler(deps: ContentReadDeps): APIGatewayProxyHandlerV2 {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: CONTENT_READ_LOG_SAMPLE_RATE });

  return async (event) => {
    const start = clock.now();

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: '/content',
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // Flag: content.readApi.enabled — default off until TASK 1.3.2 can
    // populate real content (05-execution-plan.md, TASK 1.3.1's Flag line).
    if (!(await deps.flags.isEnabled('content.readApi.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const keyword = event.queryStringParameters?.keyword;
    if (!keyword) {
      return respond(400, { error: 'KEYWORD_REQUIRED' });
    }

    const items = await deps.repository.findPublishedByKeyword(keyword);
    return respond(200, { items });
  };
}
