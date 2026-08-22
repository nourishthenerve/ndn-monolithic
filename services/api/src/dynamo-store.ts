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
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Clinician, ContentItem, Registration, Testimonial, Workshop } from '@ndn/shared-types';

import type { ClinicianStore } from './clinician-repository.js';
import type { ContentStore } from './content-repository.js';
import { AppError } from './errors.js';
import type { RegistrationStore, WorkshopCapacityStore } from './registration-repository.js';
import type { KeyValueStore } from './store.js';
import type { WebhookEventStore } from './stripe-webhook.js';
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

// TASK 1.5.2: same table, same WORKSHOP#<id> pk prefix, two more sort keys
// under it. `REGISTRATION#<id>` rows are ordinary registration records
// (DynamoRegistrationStore); the single `CAPACITY` row per workshop is a
// deliberately separate item from the workshop's own `META` row — see
// registration-repository.ts's own header comment for why (a lost-update
// race between an admin's plain-overwrite edit and this store's atomic
// increment/decrement if the two shared a row).
const REGISTRATION_SK = (id: string) => `REGISTRATION#${id}`;
const WORKSHOP_CAPACITY_SORT_KEY = 'CAPACITY';

// TASK 1.5.2: webhook idempotency rows. A distinct pk prefix (`STRIPE_EVENT#`)
// can't collide with any entity's own pk (`CONTENT#`/`TESTIMONIAL#`/
// `WORKSHOP#`) — no gsi2pk/gsi2sk, so these never surface in a GSI2 query
// either.
const STRIPE_EVENT_PK = (eventId: string) => `STRIPE_EVENT#${eventId}`;
const STRIPE_EVENT_SORT_KEY = 'RECEIVED';

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

export interface DynamoRegistrationStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

// TASK 1.5.2: `PK = WORKSHOP#<id>` / `SK = REGISTRATION#<id>` — same table,
// a sort key under the workshop's own partition rather than a new pk
// prefix, per the execution plan's own key shape for this entity.
export class DynamoRegistrationStore implements RegistrationStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoRegistrationStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async get(workshopId: string, id: string): Promise<Registration | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: WORKSHOP_PK(workshopId), sk: REGISTRATION_SK(id) },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<Registration>(result.Item);
  }

  async create(item: Registration): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, pk: WORKSHOP_PK(item.workshopId), sk: REGISTRATION_SK(item.id) },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError('RECORD_ALREADY_EXISTS', `registration ${item.id} already exists`);
      }
      throw error;
    }
  }

  async update(item: Registration): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...item, pk: WORKSHOP_PK(item.workshopId), sk: REGISTRATION_SK(item.id) },
      }),
    );
  }
}

export interface DynamoWorkshopCapacityStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

// TASK 1.5.2: `PK = WORKSHOP#<id>` / `SK = CAPACITY` — a single atomic
// counter row per workshop, deliberately separate from that workshop's own
// `META` row (registration-repository.ts's own header comment explains
// why). `UpdateCommand`, not `PutCommand`: an atomic ConditionExpression-
// guarded increment/decrement, same shape sms-spend-cap.ts's real
// implementation would take (0.5.3 never deployed a real DynamoDB-backed
// SpendCounterStore — this is that same pattern's first real exercise).
export class DynamoWorkshopCapacityStore implements WorkshopCapacityStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoWorkshopCapacityStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async tryReserve(workshopId: string, capacity: number): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: WORKSHOP_PK(workshopId), sk: WORKSHOP_CAPACITY_SORT_KEY },
          UpdateExpression: 'SET registeredCount = if_not_exists(registeredCount, :zero) + :one',
          ConditionExpression:
            'attribute_not_exists(registeredCount) OR registeredCount < :capacity',
          ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':capacity': capacity },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }

  async release(workshopId: string): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: WORKSHOP_PK(workshopId), sk: WORKSHOP_CAPACITY_SORT_KEY },
          UpdateExpression: 'SET registeredCount = registeredCount - :one',
          ConditionExpression: 'attribute_exists(registeredCount) AND registeredCount > :zero',
          ExpressionAttributeValues: { ':one': 1, ':zero': 0 },
        }),
      );
    } catch (error) {
      // Nothing to release (already zero, or never reserved) — a no-op,
      // same contract InMemoryWorkshopCapacityStore.release documents.
      if (error instanceof ConditionalCheckFailedException) {
        return;
      }
      throw error;
    }
  }
}

export interface DynamoWebhookEventStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

// TASK 1.5.2: `PK = STRIPE_EVENT#<event.id>` / `SK = RECEIVED` — a
// conditional Put is exactly "atomically record that this id has been
// seen": the first delivery's Put succeeds, every re-delivery's Put fails
// the `attribute_not_exists` condition and is treated as already-claimed.
export class DynamoWebhookEventStore implements WebhookEventStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoWebhookEventStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async tryClaim(eventId: string): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { pk: STRIPE_EVENT_PK(eventId), sk: STRIPE_EVENT_SORT_KEY },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
}

// TASK 2.4.1: `PK = CLI#<sub>` / `SK = META` — the clinician-repository.ts
// header explains why the record is keyed by the Cognito `sub`. The
// singleton "exactly one principal" marker is a second, fixed-key row
// (`PK = CLI#PRINCIPAL_MARKER`), conditioned in the *same* transaction as
// the main item so the invariant holds even under concurrent creates.
const CLINICIAN_PK = (id: string) => `CLI#${id}`;
const CLINICIAN_PRINCIPAL_MARKER_PK = 'CLI#PRINCIPAL_MARKER';
const CLINICIAN_PRINCIPAL_MARKER_SK = 'MARKER';

export interface DynamoClinicianStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoClinicianStore implements ClinicianStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoClinicianStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async get(id: string): Promise<Clinician | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: CLINICIAN_PK(id), sk: META_SORT_KEY },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<Clinician>(result.Item);
  }

  /**
   * On `TransactionCanceledException`, a follow-up `get` disambiguates
   * which condition failed — deliberately not `CancellationReasons`
   * parsing/ordering, which is a real but SDK/version-shaped detail this
   * store does not want to depend on for choosing between two very
   * differently-meaning errors. One extra read, on the (rare) failure path
   * only.
   */
  async create(item: Clinician): Promise<void> {
    const mainItem = { ...item, pk: CLINICIAN_PK(item.id), sk: META_SORT_KEY };
    const transactItems = [
      {
        Put: {
          TableName: this.tableName,
          Item: mainItem,
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
      ...(item.role === 'principal'
        ? [
            {
              Put: {
                TableName: this.tableName,
                Item: {
                  pk: CLINICIAN_PRINCIPAL_MARKER_PK,
                  sk: CLINICIAN_PRINCIPAL_MARKER_SK,
                  clinicianId: item.id,
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ]
        : []),
    ];

    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactItems }));
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        const existing = await this.get(item.id);
        if (existing) {
          throw new AppError('RECORD_ALREADY_EXISTS', `clinician ${item.id} already exists`);
        }
        throw new AppError('PRINCIPAL_ALREADY_EXISTS', 'a principal clinician already exists');
      }
      throw error;
    }
  }

  /** Plain overwrite — deactivate/reactivate. Never touches the principal marker: role is immutable through this path. */
  async update(item: Clinician): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...item, pk: CLINICIAN_PK(item.id), sk: META_SORT_KEY },
      }),
    );
  }
}
