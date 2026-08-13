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

import type { AuditWriter } from './audit.js';
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
    for (const keyword of item.keywords) {
      const ids = this.keywordIndex.get(keyword) ?? new Set<string>();
      ids.add(item.id);
      this.keywordIndex.set(keyword, ids);
    }
  }

  async queryIdsByKeyword(keyword: string): Promise<string[]> {
    return [...(this.keywordIndex.get(keyword) ?? [])];
  }
}

export type CreateContentInput = Omit<ContentItem, 'created_at' | 'updated_at'>;

export class ContentRepository {
  constructor(
    private readonly store: ContentStore,
    private readonly audit: AuditWriter,
    private readonly clock: Clock,
  ) {}

  async create(actor: string, data: CreateContentInput): Promise<ContentItem> {
    const now = this.clock.now().toISOString();
    const item: ContentItem = { ...data, created_at: now, updated_at: now };
    await this.store.create(item);
    await this.audit.write({
      at: now,
      actor,
      action: 'create',
      entityType: 'Content',
      entityId: item.id,
    });
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
