// TASK 1.3.1: first real DynamoDB-backed implementations. Two, deliberately
// separate:
//
// - `DynamoStore<T>` implements `KeyValueStore<T>` (store.ts, TASK 0.3.3's
//   seam) — a generic single-item get/put against one table. Repository and
//   VersionedRepository are unchanged; this is the piece that lets a future
//   entity swap `InMemoryStore` for a real table with no other code change.
// - `DynamoContentStore` implements `ContentStore` (content-repository.ts)
//   — content's atomic "main item + one GSI2 row per keyword" write can't
//   be expressed through the single-key `KeyValueStore` interface, so it
//   talks to DynamoDB directly via TransactWriteItems/Query.
//
// Both use the same table (infra/src/data-stack.ts): partition/sort key
// attributes `pk`/`sk`; GSI2's key attributes are `gsi2pk`/`gsi2sk`,
// present only on keyword-projection rows (a sparse index) so GSI2 never
// returns a content item's own META row.
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ContentItem, Testimonial, Workshop } from '@ndn/shared-types';

import type { ContentStore } from './content-repository.js';
import { AppError } from './errors.js';
import type { KeyValueStore } from './store.js';
import type { TestimonialStore } from './testimonial-repository.js';
import type { WorkshopStore } from './workshop-repository.js';

const META_SORT_KEY = 'META';
const CONTENT_PK = (id: string) => `CONTENT#${id}`;
// Used as both a keyword-projection row's own sort key and its GSI2
// partition key — same format, two different attributes (`sk` vs `gsi2pk`).
const KEYWORD_KEY = (keyword: string) => `KEYWORD#${keyword}`;
const GSI2_INDEX_NAME = 'GSI2';

// TASK 1.4.2: same table, same GSI2, a different entity type — single-table
// design's whole point. `TESTIMONIAL#<id>` never collides with `CONTENT#<id>`
// (distinct pk prefixes), and the "all testimonials" projection's gsi2pk
// (`TESTIMONIAL_INDEX#all`) can't collide with a content keyword's gsi2pk
// (always `KEYWORD#...`) either.
const TESTIMONIAL_PK = (id: string) => `TESTIMONIAL#${id}`;
const TESTIMONIAL_INDEX_SORT_KEY = 'INDEX';
const TESTIMONIAL_INDEX_GSI2PK = 'TESTIMONIAL_INDEX#all';

// TASK 1.5.1: same table, same GSI2, a third entity type. `WORKSHOP#<id>`
// can't collide with `CONTENT#<id>`/`TESTIMONIAL#<id>` (distinct pk
// prefixes), and the "all workshops" projection's fixed gsi2pk
// (`WORKSHOP_INDEX#all`) can't collide with a content keyword's
// `KEYWORD#...` or the testimonial index's `TESTIMONIAL_INDEX#all` either.
const WORKSHOP_PK = (id: string) => `WORKSHOP#${id}`;
const WORKSHOP_INDEX_SORT_KEY = 'INDEX';
const WORKSHOP_INDEX_GSI2PK = 'WORKSHOP_INDEX#all';

function defaultDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

/** Strips the table's storage-layer `pk`/`sk` attributes so callers only ever see domain fields. */
function withoutTableKeys<T>(row: Record<string, unknown>): T {
  const item = { ...row };
  delete item.pk;
  delete item.sk;
  return item as T;
}

/** Maps a `KeyValueStore<T>` key to this table's `pk`/`sk` attributes for one entity's single-item ("META") rows. */
export function singleItemKeys(pkPrefix: string): { pk(key: string): string; sk(): string } {
  return {
    pk: (key: string) => `${pkPrefix}#${key}`,
    sk: () => META_SORT_KEY,
  };
}

export interface DynamoStoreOptions {
  readonly tableName: string;
  readonly keys: { pk(key: string): string; sk(key: string): string };
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoStore<T> implements KeyValueStore<T> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly keys: DynamoStoreOptions['keys'];

  constructor(options: DynamoStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
    this.keys = options.keys;
  }

  async get(key: string): Promise<T | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: this.keys.pk(key), sk: this.keys.sk(key) },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<T>(result.Item);
  }

  async put(key: string, item: T): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...item, pk: this.keys.pk(key), sk: this.keys.sk(key) },
      }),
    );
  }
}

export interface DynamoContentStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoContentStore implements ContentStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoContentStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async get(id: string): Promise<ContentItem | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: CONTENT_PK(id), sk: META_SORT_KEY },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<ContentItem>(result.Item);
  }

  async create(item: ContentItem): Promise<void> {
    const mainItem = { ...item, pk: CONTENT_PK(item.id), sk: META_SORT_KEY };
    const keywordItems = item.keywords.map((keyword) => ({
      pk: CONTENT_PK(item.id),
      sk: KEYWORD_KEY(keyword),
      gsi2pk: KEYWORD_KEY(keyword),
      gsi2sk: CONTENT_PK(item.id),
    }));

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: mainItem,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            ...keywordItems.map((Item) => ({
              Put: { TableName: this.tableName, Item },
            })),
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        throw new AppError('RECORD_ALREADY_EXISTS', `content ${item.id} already exists`);
      }
      throw error;
    }
  }

  async queryIdsByKeyword(keyword: string): Promise<string[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI2_INDEX_NAME,
        KeyConditionExpression: 'gsi2pk = :keyword',
        ExpressionAttributeValues: { ':keyword': KEYWORD_KEY(keyword) },
      }),
    );
    const ids: string[] = [];
    for (const row of result.Items ?? []) {
      const pk = row.pk;
      if (typeof pk === 'string' && pk.startsWith('CONTENT#')) {
        ids.push(pk.slice('CONTENT#'.length));
      }
    }
    return ids;
  }

  // TASK 1.3.2: same TransactWriteItems shape as create() — the main item
  // plus one Put per current keyword — but every Put here is a plain
  // overwrite (no `attribute_not_exists` condition; the item is expected to
  // already exist) and a keyword dropped since the last write keeps its old
  // row rather than being removed. See ContentStore.update's own comment
  // (content-repository.ts) for why: DeleteItem is unavailable to this
  // store, full stop.
  async update(item: ContentItem): Promise<void> {
    const mainItem = { ...item, pk: CONTENT_PK(item.id), sk: META_SORT_KEY };
    const keywordItems = item.keywords.map((keyword) => ({
      pk: CONTENT_PK(item.id),
      sk: KEYWORD_KEY(keyword),
      gsi2pk: KEYWORD_KEY(keyword),
      gsi2sk: CONTENT_PK(item.id),
    }));

    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          { Put: { TableName: this.tableName, Item: mainItem } },
          ...keywordItems.map((Item) => ({
            Put: { TableName: this.tableName, Item },
          })),
        ],
      }),
    );
  }
}

export interface DynamoTestimonialStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

// TASK 1.4.2: mirrors DynamoContentStore's shape, but the "list everything"
// projection is a single fixed row per testimonial (its entity type never
// changes) rather than one row per keyword — see this file's own
// TESTIMONIAL_INDEX_GSI2PK comment and testimonial-repository.ts's header
// comment for why a status-keyed projection would go stale instead.
export class DynamoTestimonialStore implements TestimonialStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoTestimonialStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async get(id: string): Promise<Testimonial | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: TESTIMONIAL_PK(id), sk: META_SORT_KEY },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<Testimonial>(result.Item);
  }

  async create(item: Testimonial): Promise<void> {
    const mainItem = { ...item, pk: TESTIMONIAL_PK(item.id), sk: META_SORT_KEY };
    const indexItem = {
      pk: TESTIMONIAL_PK(item.id),
      sk: TESTIMONIAL_INDEX_SORT_KEY,
      gsi2pk: TESTIMONIAL_INDEX_GSI2PK,
      gsi2sk: TESTIMONIAL_PK(item.id),
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: mainItem,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: { TableName: this.tableName, Item: indexItem } },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        throw new AppError('RECORD_ALREADY_EXISTS', `testimonial ${item.id} already exists`);
      }
      throw error;
    }
  }

  // TASK 1.4.2 DoD: "a second write attempt to an existing consent object
  // throws rather than overwriting." A plain overwrite of the main item,
  // conditioned on the stored `consent` attribute matching exactly what
  // this write is about to write back — every real caller (publish/reject)
  // only ever echoes `consent` unchanged, so this never fires outside a bug.
  async update(item: Testimonial): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, pk: TESTIMONIAL_PK(item.id), sk: META_SORT_KEY },
          ConditionExpression: 'consent = :expectedConsent',
          ExpressionAttributeValues: { ':expectedConsent': item.consent },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'CONSENT_IMMUTABLE',
          `testimonial ${item.id} consent is immutable once recorded`,
        );
      }
      throw error;
    }
  }

  async listAllIds(): Promise<string[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI2_INDEX_NAME,
        KeyConditionExpression: 'gsi2pk = :indexKey',
        ExpressionAttributeValues: { ':indexKey': TESTIMONIAL_INDEX_GSI2PK },
      }),
    );
    const ids: string[] = [];
    for (const row of result.Items ?? []) {
      const pk = row.pk;
      if (typeof pk === 'string' && pk.startsWith('TESTIMONIAL#')) {
        ids.push(pk.slice('TESTIMONIAL#'.length));
      }
    }
    return ids;
  }
}

export interface DynamoWorkshopStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

// TASK 1.5.1: mirrors DynamoTestimonialStore's shape — a single fixed "all
// workshops" projection row per workshop, filtered by status and by
// "hasn't happened yet" in application code (workshop-repository.ts).
// `update()` is a plain overwrite (no consent-style immutability guard —
// workshops have no equivalent field).
export class DynamoWorkshopStore implements WorkshopStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoWorkshopStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async get(id: string): Promise<Workshop | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: WORKSHOP_PK(id), sk: META_SORT_KEY },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<Workshop>(result.Item);
  }

  async create(item: Workshop): Promise<void> {
    const mainItem = { ...item, pk: WORKSHOP_PK(item.id), sk: META_SORT_KEY };
    const indexItem = {
      pk: WORKSHOP_PK(item.id),
      sk: WORKSHOP_INDEX_SORT_KEY,
      gsi2pk: WORKSHOP_INDEX_GSI2PK,
      gsi2sk: WORKSHOP_PK(item.id),
    };

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: mainItem,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: { TableName: this.tableName, Item: indexItem } },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        throw new AppError('RECORD_ALREADY_EXISTS', `workshop ${item.id} already exists`);
      }
      throw error;
    }
  }

  async update(item: Workshop): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...item, pk: WORKSHOP_PK(item.id), sk: META_SORT_KEY },
      }),
    );
  }

  async listAllIds(): Promise<string[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI2_INDEX_NAME,
        KeyConditionExpression: 'gsi2pk = :indexKey',
        ExpressionAttributeValues: { ':indexKey': WORKSHOP_INDEX_GSI2PK },
      }),
    );
    const ids: string[] = [];
    for (const row of result.Items ?? []) {
      const pk = row.pk;
      if (typeof pk === 'string' && pk.startsWith('WORKSHOP#')) {
        ids.push(pk.slice('WORKSHOP#'.length));
      }
    }
    return ids;
  }
}
