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
import { randomUUID } from 'node:crypto';

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
import type {
  Appointment,
  Assessment,
  AssignmentRequest,
  ClinicalRecord,
  Clinician,
  ContentAssignment,
  ContentItem,
  Patient,
  Registration,
  Testimonial,
  Workshop,
} from '@ndn/shared-types';

import type { AppointmentStore } from './appointment-repository.js';
import type { AssignmentStore } from './assignment-repository.js';
import type { CaseloadStore } from './caseload-repository.js';
import type { ClinicianStore } from './clinician-repository.js';
import type { ContentAssignmentStore } from './content-assignment-repository.js';
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

// TASK 2.5.1: `PK = PAT#<id>` / `SK = ASSIGNREQ#<ts>#<random>` for each
// decision row (the random suffix guards a same-millisecond collision the
// same way dynamo-audit-log.ts's does — low-odds here, given decisions
// are single-principal, human-paced actions, but cheap insurance and the
// established convention). The patient's own `PAT#<id>` / `PROFILE` row
// (post-confirmation-handler.ts's key shape, unchanged) is overwritten in
// the same transaction.
//
// **GSI1's shape, proved against both access patterns docs/adr/0002-
// database.md records:** `gsi1pk = CLI#<clinicianId>`, `gsi1sk =
// PAT#<patientId>` for the "clinician → patients" pattern this task
// builds; `gsi1sk = APPT#<iso-utc>` (TASK 3.4.x, not built here) shares
// the same partition for "clinician calendar" — each pattern queries its
// own `gsi1sk` prefix, so the two entity types never collide in a query
// even though they share a partition. Sparse: `gsi1pk`/`gsi1sk` exist on
// a `PROFILE` row only while `assigned_clinician_id` is set, derived from
// that field alone — never a second input a caller could pass out of
// step with it.
//
// TASK 2.5.3 adds GSI3 (its own proof, same file): `gsi3pk =
// 'CASELOAD#all'` / `gsi3sk = CLI#<clinicianId>#PAT#<patientId>`, set in
// the same conditional block below, on the same condition — one write,
// two indexes, no second decision about when a patient belongs in either.
const PATIENT_PK = (id: string) => `PAT#${id}`;
const PATIENT_PROFILE_SK = 'PROFILE';
const ASSIGNMENT_REQUEST_SK = (at: string, suffix: string) => `ASSIGNREQ#${at}#${suffix}`;
const GSI1_INDEX_NAME = 'GSI1';
const GSI1_CLINICIAN_PK = (clinicianId: string) => `CLI#${clinicianId}`;
const GSI1_PATIENT_SK = (patientId: string) => `PAT#${patientId}`;

// TASK 2.5.3: GSI3's shape, proved in docs/adr/0002-database.md — one
// fixed partition value (the same "_all" shape TESTIMONIAL_INDEX_GSI2PK/
// WORKSHOP_INDEX_GSI2PK already use, on their own index rather than
// sharing GSI2), sorted by clinician so one Query returns the whole
// cross-caseload list already grouped.
const GSI3_INDEX_NAME = 'GSI3';
const GSI3_CASELOAD_PK = 'CASELOAD#all';
const GSI3_CASELOAD_SK = (clinicianId: string, patientId: string) =>
  `CLI#${clinicianId}#PAT#${patientId}`;

export interface DynamoAssignmentStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
  /** Defaults to node:crypto's randomUUID — injectable so a test can force a key collision. */
  readonly newRequestSuffix?: () => string;
}

export class DynamoAssignmentStore implements AssignmentStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly newRequestSuffix: () => string;

  constructor(options: DynamoAssignmentStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
    this.newRequestSuffix = options.newRequestSuffix ?? randomUUID;
  }

  async getPatient(patientId: string): Promise<Patient | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: PATIENT_PK(patientId), sk: PATIENT_PROFILE_SK },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<Patient>(result.Item);
  }

  /**
   * The atomic write step 2 asks for: the `ASSIGNREQ#` row (conditioned
   * on not already existing — collision, not overwrite, on the
   * vanishingly unlikely case) and the patient's `PROFILE` row, in one
   * `TransactWriteItems`. Neither commits without the other — "an
   * approved patient nobody is responsible for" is exactly the state a
   * partial write would produce, and `TransactWriteItems` is what DynamoDB
   * itself refuses to leave partially applied.
   */
  async writeDecision(request: AssignmentRequest, patient: Patient): Promise<void> {
    const requestItem = {
      ...request,
      pk: PATIENT_PK(request.patientId),
      sk: ASSIGNMENT_REQUEST_SK(request.decidedAt ?? request.requestedAt, this.newRequestSuffix()),
    };
    const patientItem: Record<string, unknown> = {
      ...patient,
      pk: PATIENT_PK(patient.id),
      sk: PATIENT_PROFILE_SK,
    };
    // Sparse, derived from `assigned_clinician_id` alone — see this
    // section's header. Simply omitted (not set to `undefined`) when
    // there is no assignment, so a decline's `PutCommand` never tries to
    // marshall an explicit `undefined` value. GSI3 (TASK 2.5.3) piggybacks
    // on the same condition: `assigned_clinician_id` is only ever set by
    // this store alongside `account_status: 'approved'` (approve/reassign
    // both do both in the same write), so "carries a clinician" and
    // "belongs in the caseload view" are the same fact here, not two
    // conditions that could drift apart.
    if (patient.assigned_clinician_id) {
      patientItem.gsi1pk = GSI1_CLINICIAN_PK(patient.assigned_clinician_id);
      patientItem.gsi1sk = GSI1_PATIENT_SK(patient.id);
      patientItem.gsi3pk = GSI3_CASELOAD_PK;
      patientItem.gsi3sk = GSI3_CASELOAD_SK(patient.assigned_clinician_id, patient.id);
    }

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: requestItem,
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
            { Put: { TableName: this.tableName, Item: patientItem } },
          ],
        }),
      );
    } catch (error) {
      if (error instanceof TransactionCanceledException) {
        throw new AppError(
          'ASSIGNMENT_REQUEST_ALREADY_EXISTS',
          `assignment request ${String(requestItem.sk)} already exists`,
        );
      }
      throw error;
    }
  }

  async listPatientIdsForClinician(clinicianId: string): Promise<string[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1_INDEX_NAME,
        KeyConditionExpression: 'gsi1pk = :clinicianKey AND begins_with(gsi1sk, :patientPrefix)',
        ExpressionAttributeValues: {
          ':clinicianKey': GSI1_CLINICIAN_PK(clinicianId),
          ':patientPrefix': 'PAT#',
        },
      }),
    );
    const ids: string[] = [];
    for (const row of result.Items ?? []) {
      const gsi1sk = row.gsi1sk;
      if (typeof gsi1sk === 'string' && gsi1sk.startsWith('PAT#')) {
        ids.push(gsi1sk.slice('PAT#'.length));
      }
    }
    return ids;
  }
}

// TASK 2.5.3: the cross-caseload view's cursor — DynamoDB's own
// `LastEvaluatedKey`, opaque to the caller, base64url-encoded so it
// travels safely as a query-string value. Never anything else: no offset,
// no page number, nothing that would let a caller skip into the middle of
// a GSI3 partition without the key DynamoDB itself issued.
function encodeCaseloadCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(key), 'utf-8').toString('base64url');
}

function decodeCaseloadCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    throw new AppError('INVALID_CURSOR', 'cursor could not be decoded');
  }
}

export interface DynamoCaseloadStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoCaseloadStore implements CaseloadStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoCaseloadStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  /**
   * One bounded `Query` against GSI3 (docs/adr/0002-database.md's proof),
   * sorted by clinician — never a `Scan`, never more than `limit` items
   * read, never a second page fetched to build this one (step 5).
   */
  async queryPage(
    cursor: string | undefined,
    limit: number,
  ): Promise<{ patientIds: string[]; nextCursor?: string }> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI3_INDEX_NAME,
        KeyConditionExpression: 'gsi3pk = :caseloadKey',
        ExpressionAttributeValues: { ':caseloadKey': GSI3_CASELOAD_PK },
        Limit: limit,
        ExclusiveStartKey: decodeCaseloadCursor(cursor),
      }),
    );
    const patientIds: string[] = [];
    for (const row of result.Items ?? []) {
      const gsi3sk = row.gsi3sk;
      if (typeof gsi3sk === 'string') {
        // `CLI#<clinicianId>#PAT#<patientId>` — the patient id is
        // everything after the last `#PAT#` marker; clinician ids are
        // Cognito subs (UUIDs, no `#`), so this is unambiguous.
        const patientId = gsi3sk.split('#PAT#').pop();
        if (patientId) {
          patientIds.push(patientId);
        }
      }
    }
    return { patientIds, nextCursor: encodeCaseloadCursor(result.LastEvaluatedKey) };
  }

  async getPatient(patientId: string): Promise<Patient | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: PATIENT_PK(patientId), sk: PATIENT_PROFILE_SK },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<Patient>(result.Item);
  }
}

// TASK 3.2.1: `PK = PAT#<id>` (the same partition every other patient-owned
// row lives in), `SK = DIAG#v<n>` / `PLAN#v<n>` per
// docs/plan/04-data-model-rbac.md's own key shape. `versionKey`'s
// `${id}#v${version}` (versioned-repository.ts, private to that file) is
// this store's own `KeyValueStore<T>` key — parsed back apart here rather
// than re-exported, so the split-key format stays this pair of files'
// concern and no third file has to know it.
const CLINICAL_RECORD_SK_PREFIX = { diagnosis: 'DIAG', 'care-plan': 'PLAN' } as const;

function parseVersionKey(key: string): { readonly patientId: string; readonly version: string } {
  const marker = key.lastIndexOf('#v');
  return { patientId: key.slice(0, marker), version: key.slice(marker + 2) };
}

export interface DynamoClinicalRecordStoreOptions {
  readonly tableName: string;
  readonly kind: keyof typeof CLINICAL_RECORD_SK_PREFIX;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoClinicalRecordStore implements KeyValueStore<ClinicalRecord> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly skPrefix: string;

  constructor(options: DynamoClinicalRecordStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
    this.skPrefix = CLINICAL_RECORD_SK_PREFIX[options.kind];
  }

  async get(key: string): Promise<ClinicalRecord | undefined> {
    const { patientId, version } = parseVersionKey(key);
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: PATIENT_PK(patientId), sk: `${this.skPrefix}#v${version}` },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<ClinicalRecord>(result.Item);
  }

  /**
   * `VersionedRepository.createVersion` already checks-then-throws at the
   * application layer before ever calling this — the `ConditionExpression`
   * below is the atomic backstop for the race that check alone cannot
   * close (two concurrent writers both passing the pre-check for the same
   * version), the same defence-in-depth shape `DynamoWorkshopCapacityStore`
   * and `DynamoAssignmentStore` already use elsewhere in this file. Both
   * paths surface the identical `AppError` code, so `clinical-record.ts`'s
   * one `catch` handles either.
   */
  async put(key: string, item: ClinicalRecord): Promise<void> {
    const { patientId, version } = parseVersionKey(key);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, pk: PATIENT_PK(patientId), sk: `${this.skPrefix}#v${version}` },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'VERSION_ALREADY_EXISTS',
          `version ${version} already exists for patient ${patientId}`,
        );
      }
      throw error;
    }
  }
}

// TASK 3.3.1: `PK = PAT#<patientId>`, `SK = ASSESS#<assessmentId>#v<n>` —
// unlike diagnosis/care-plan's single timeline per patient, an assessment
// versions per *named form*, so the sort key carries both the form's own
// id and its version. `assessment-repository.ts`'s own `compositeId`
// packs `patientId`/`assessmentId` into `VersionedRepository`'s one `id`
// string as `${patientId}#${assessmentId}`; this store is what unpacks it
// back into `pk`/`sk` — parsed here, not passed in pre-split, the same
// division of concerns `DynamoClinicalRecordStore` keeps just above.
//
// The parse is unambiguous in both directions regardless of what
// characters `assessmentId` itself contains: `lastIndexOf('#v')` finds
// the version marker because it is always the literal suffix nothing
// follows, and `indexOf('#')` on what remains finds the patient/assessment
// boundary because a patient id (a Cognito `sub`, a UUID) never contains
// `#` — the same guarantee `caseload-repository.ts`'s own GSI3 sort-key
// parsing already relies on.
const ASSESSMENT_SK_PREFIX = 'ASSESS';

function parseAssessmentVersionKey(key: string): {
  readonly patientId: string;
  readonly assessmentId: string;
  readonly version: string;
} {
  const versionMarker = key.lastIndexOf('#v');
  const withoutVersion = key.slice(0, versionMarker);
  const version = key.slice(versionMarker + 2);
  const patientSeparator = withoutVersion.indexOf('#');
  return {
    patientId: withoutVersion.slice(0, patientSeparator),
    assessmentId: withoutVersion.slice(patientSeparator + 1),
    version,
  };
}

function assessmentSortKey(assessmentId: string, version: string): string {
  return `${ASSESSMENT_SK_PREFIX}#${assessmentId}#v${version}`;
}

export interface DynamoAssessmentStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoAssessmentStore implements KeyValueStore<Assessment> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoAssessmentStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async get(key: string): Promise<Assessment | undefined> {
    const { patientId, assessmentId, version } = parseAssessmentVersionKey(key);
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: PATIENT_PK(patientId), sk: assessmentSortKey(assessmentId, version) },
      }),
    );
    if (!result.Item) {
      return undefined;
    }
    return withoutTableKeys<Assessment>(result.Item);
  }

  /**
   * The same defence-in-depth shape `DynamoClinicalRecordStore.put` uses:
   * `VersionedRepository.createVersion`'s own check-then-throw is the
   * common path, and this `ConditionExpression` is the atomic backstop
   * for two concurrent writers targeting the same named form's same
   * version — both surface the identical `AppError` code.
   */
  async put(key: string, item: Assessment): Promise<void> {
    const { patientId, assessmentId, version } = parseAssessmentVersionKey(key);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...item,
            pk: PATIENT_PK(patientId),
            sk: assessmentSortKey(assessmentId, version),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'VERSION_ALREADY_EXISTS',
          `assessment ${assessmentId} version ${version} already exists for patient ${patientId}`,
        );
      }
      throw error;
    }
  }
}

// TASK 3.4.1: `docs/adr/0002-database.md` proved this shape before either
// GSI1 or this entity existed — `gsi1pk = CLI#<clinicianId>`, `gsi1sk =
// APPT#<scheduledAt>`, on the identical partition TASK 2.5.1's own
// `PAT#<patientId>` clinician→patients projection already uses. The two
// patterns never collide even sharing a partition: each query scopes its
// own `gsi1sk` prefix (`PAT#` vs `APPT#`), and a `BETWEEN 'APPT#<from>'
// AND 'APPT#<to>'` bound can never stray into the `PAT#` range.
//
// The main-table sort key and GSI1's projected sort key are the identical
// string (`APPT#<scheduledAt>`) — one function derives both, so they
// cannot drift apart the way two independently-written literals could.
const APPOINTMENT_SORT_KEY = (scheduledAt: string) => `APPT#${scheduledAt}`;
const APPOINTMENT_SORT_KEY_PREFIX = 'APPT#';

// TASK 3.4.3: GSI4's shape, proved in docs/adr/0002-database.md — one
// fixed partition value (the same "_all"-shaped precedent GSI3's own
// `CASELOAD#all` already establishes for a query with no natural
// per-entity partition), `gsi4sk = <iso-utc>#<patientId>` so the index
// sorts chronologically and stays unique across two patients who share
// an exact instant.
const GSI4_INDEX_NAME = 'GSI4';
const GSI4_REMINDER_PK = 'APPT#REMINDER';
const GSI4_REMINDER_SK = (scheduledAt: string, patientId: string) => `${scheduledAt}#${patientId}`;

export interface DynamoAppointmentStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoAppointmentStore implements AppointmentStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoAppointmentStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async create(appointment: Appointment): Promise<void> {
    const sk = APPOINTMENT_SORT_KEY(appointment.scheduledAt);
    // TASK 3.4.3: GSI4's projection, sparse — only while the appointment
    // is genuinely a future one at the moment it's created.
    // `scheduledAt > created_at` is that check without a second clock
    // dependency in this store: `created_at` already *is* "now" at
    // creation (the repository stamps both from the same `Clock` read).
    // Never re-evaluated later — an appointment that ages past its own
    // `scheduledAt` without being reminded (a missed sweep window) stays
    // in GSI4 rather than silently falling out of it; `docs/adr/0002-
    // database.md`'s own proof names cleanup as the sweep's job, not
    // this store's.
    const isFutureAtCreation = appointment.scheduledAt > appointment.created_at;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...appointment,
            pk: PATIENT_PK(appointment.patientId),
            sk,
            // Derived from `clinicianId`/`scheduledAt` alone — see this
            // section's header — never a separate input a caller could
            // pass out of step with the fields they're projected from.
            gsi1pk: GSI1_CLINICIAN_PK(appointment.clinicianId),
            gsi1sk: sk,
            ...(isFutureAtCreation
              ? {
                  gsi4pk: GSI4_REMINDER_PK,
                  gsi4sk: GSI4_REMINDER_SK(appointment.scheduledAt, appointment.patientId),
                }
              : {}),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'APPOINTMENT_ALREADY_EXISTS',
          `patient ${appointment.patientId} already has an appointment at ${appointment.scheduledAt}`,
        );
      }
      throw error;
    }
  }

  async listForPatient(patientId: string): Promise<Appointment[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :apptPrefix)',
        ExpressionAttributeValues: {
          ':patientKey': PATIENT_PK(patientId),
          ':apptPrefix': APPOINTMENT_SORT_KEY_PREFIX,
        },
      }),
    );
    return (result.Items ?? []).map((item) => withoutTableKeys<Appointment>(item));
  }

  /**
   * GSI1 is `KEYS_ONLY` (`infra/src/data-stack.ts`) — the query below
   * returns only key attributes, which *does* include the table's own
   * `pk`/`sk` (DynamoDB always projects the base table's primary key into
   * every secondary index, regardless of the index's own projection
   * type), so each row names exactly the `GetItem` that fetches its full
   * record. The same two-step shape `DynamoCaseloadStore.queryPage` +
   * `getPatient` already uses for GSI3, for the identical reason.
   */
  async listForClinicianCalendar(
    clinicianId: string,
    from: string,
    to: string,
  ): Promise<Appointment[]> {
    const queryResult = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI1_INDEX_NAME,
        KeyConditionExpression: 'gsi1pk = :clinicianKey AND gsi1sk BETWEEN :fromKey AND :toKey',
        ExpressionAttributeValues: {
          ':clinicianKey': GSI1_CLINICIAN_PK(clinicianId),
          ':fromKey': APPOINTMENT_SORT_KEY(from),
          ':toKey': APPOINTMENT_SORT_KEY(to),
        },
      }),
    );
    const appointments: Appointment[] = [];
    for (const row of queryResult.Items ?? []) {
      const pk = row.pk;
      const sk = row.sk;
      if (typeof pk !== 'string' || typeof sk !== 'string') {
        continue;
      }
      const result = await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: { pk, sk } }),
      );
      // TASK 3.4.2: "index gives candidates, the read confirms them" —
      // the identical discipline `DynamoCaseloadStore.queryPage` already
      // uses for its own stale-row case. A cancelled appointment stays a
      // real GSI1 row (cancelling never touches `gsi1pk`/`gsi1sk`) but
      // has no business on a clinician's live calendar; `listForPatient`
      // below applies no such filter, since a patient's own history is a
      // different question this file answers differently on purpose.
      if (result.Item && result.Item.appointment_status !== 'cancelled') {
        appointments.push(withoutTableKeys<Appointment>(result.Item));
      }
    }
    return appointments;
  }

  /**
   * `appointment_status` alone — never `scheduledAt`, so `gsi1pk`/`gsi1sk`
   * (derived from `clinicianId`/`scheduledAt`) never need re-deriving.
   * `ReturnValues: 'ALL_NEW'` hands back the updated row in the same
   * round trip a separate `GetItem` would otherwise cost.
   */
  async cancel(patientId: string, scheduledAt: string, now: string): Promise<Appointment> {
    const sk = APPOINTMENT_SORT_KEY(scheduledAt);
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: PATIENT_PK(patientId), sk },
          UpdateExpression: 'SET appointment_status = :cancelled, updated_at = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':cancelled': 'cancelled', ':now': now },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return withoutTableKeys<Appointment>(result.Attributes ?? {});
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'RECORD_NOT_FOUND',
          `no appointment for patient ${patientId} at ${scheduledAt}`,
        );
      }
      throw error;
    }
  }

  /**
   * GSI4 is `KEYS_ONLY` — the query below returns only key attributes
   * (which does include the table's own `pk`/`sk`, always projected
   * regardless of the index's own projection type), so each row names
   * exactly the `GetItem` that fetches its full record. `appointment_
   * status`/`reminder_sent_at` are not attributes GSI4 carries, so
   * excluding an ineligible row can only happen after that fetch —
   * `docs/adr/0002-database.md`'s own proof states why a literal
   * DynamoDB `FilterExpression` naming either could never do this here.
   *
   * The upper bound is `windowEnd` plus one millisecond, not `windowEnd`
   * itself: `gsi4sk` is `<iso-utc>#<patientId>`, always strictly longer
   * than a bare `windowEnd` string that shares its prefix, and a longer
   * string that starts with a shorter one sorts *after* it — so an
   * appointment scheduled at the exact instant `windowEnd` names would
   * otherwise fall just outside an inclusive `BETWEEN`. Nudging the bound
   * forward by the smallest real unit of time this key format can
   * resolve closes that gap without needing a sentinel character.
   */
  async listReminderCandidates(windowStart: string, windowEnd: string): Promise<Appointment[]> {
    const inclusiveWindowEnd = new Date(new Date(windowEnd).getTime() + 1).toISOString();
    const queryResult = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: GSI4_INDEX_NAME,
        KeyConditionExpression: 'gsi4pk = :reminderKey AND gsi4sk BETWEEN :fromKey AND :toKey',
        ExpressionAttributeValues: {
          ':reminderKey': GSI4_REMINDER_PK,
          ':fromKey': windowStart,
          ':toKey': inclusiveWindowEnd,
        },
      }),
    );
    const appointments: Appointment[] = [];
    for (const row of queryResult.Items ?? []) {
      const pk = row.pk;
      const sk = row.sk;
      if (typeof pk !== 'string' || typeof sk !== 'string') {
        continue;
      }
      const result = await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: { pk, sk } }),
      );
      const item = result.Item;
      if (
        item &&
        item.appointment_status === 'scheduled' &&
        item.reminder_sent_at === undefined
      ) {
        appointments.push(withoutTableKeys<Appointment>(item));
      }
    }
    return appointments;
  }

  /**
   * The atomic claim: conditioned on `reminder_sent_at` being absent
   * *and* the row existing, so two overlapping sweeps (or one sweep's
   * candidate appearing again on the next tick before it's excluded by
   * the check above) can never both proceed to send. `gsi4pk`/`gsi4sk`
   * are untouched — the same "index gives candidates, the read confirms
   * them" split `listReminderCandidates` and `cancel` both already keep,
   * never a write that also has to re-derive an index projection.
   */
  async claimForReminder(
    patientId: string,
    scheduledAt: string,
    now: string,
  ): Promise<Appointment | undefined> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: PATIENT_PK(patientId), sk: APPOINTMENT_SORT_KEY(scheduledAt) },
          UpdateExpression: 'SET reminder_sent_at = :now',
          ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(reminder_sent_at)',
          ExpressionAttributeValues: { ':now': now },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return withoutTableKeys<Appointment>(result.Attributes ?? {});
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return undefined;
      }
      throw error;
    }
  }
}

// TASK 3.5.1: `PAT#<id>` / `CONTENT#<id>` — the minimal key shape
// `04-data-model-rbac.md` gives this entity, no GSI of its own. The
// content item's own record stays at `CONTENT#<id>` / `META`
// (`DynamoContentStore` above); this store only ever writes and reads the
// assignment link.
const CONTENT_ASSIGNMENT_SORT_KEY = (contentId: string) => `CONTENT#${contentId}`;
const CONTENT_ASSIGNMENT_SORT_KEY_PREFIX = 'CONTENT#';

export interface DynamoContentAssignmentStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoContentAssignmentStore implements ContentAssignmentStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoContentAssignmentStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async create(assignment: ContentAssignment): Promise<void> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: {
            ...assignment,
            pk: PATIENT_PK(assignment.patientId),
            sk: CONTENT_ASSIGNMENT_SORT_KEY(assignment.contentId),
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'RECORD_ALREADY_EXISTS',
          `patient ${assignment.patientId} already has content ${assignment.contentId} assigned`,
        );
      }
      throw error;
    }
  }

  async listForPatient(patientId: string): Promise<ContentAssignment[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :contentPrefix)',
        ExpressionAttributeValues: {
          ':patientKey': PATIENT_PK(patientId),
          ':contentPrefix': CONTENT_ASSIGNMENT_SORT_KEY_PREFIX,
        },
      }),
    );
    return (result.Items ?? []).map((item) => withoutTableKeys<ContentAssignment>(item));
  }
}
