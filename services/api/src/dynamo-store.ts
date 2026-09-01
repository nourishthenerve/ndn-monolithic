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
import type { QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type {
  Appointment,
  Assessment,
  AssignmentRequest,
  ClinicalRecord,
  Clinician,
  ContentAssignment,
  ContentItem,
  Message,
  Patient,
  PatientAccountStatus,
  PatientNotification,
  Registration,
  Testimonial,
  Workshop,
} from '@ndn/shared-types';

import type { AppointmentStore, AppointmentTransition } from './appointment-repository.js';
import type { AssignmentStore } from './assignment-repository.js';
import type { CaseloadStore } from './caseload-repository.js';
import type { ClinicianStore } from './clinician-repository.js';
import type { ContentAssignmentStore } from './content-assignment-repository.js';
import type { ContentStore } from './content-repository.js';
import { AppError } from './errors.js';
import type { MessagePage, MessageStore } from './message-repository.js';
import type { PatientNotificationStore } from './patient-notification-repository.js';
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

/**
 * `removeUndefinedValues` added 2026-08-31, after a live 500 on
 * `POST /patients` (patient-admin.ts's own note has the full trace).
 * Without it, one `undefined` anywhere in an item — including nested,
 * which is where it happened — makes the document client throw rather than
 * write, and the caller sees a 500 with nothing in it naming the field.
 *
 * DynamoDB has no `undefined`: an attribute is present or it is not.
 * Dropping the key is therefore the only thing "write `undefined`" could
 * faithfully mean, and doing it here makes an entire class of "an optional
 * field was left blank" 500 unrepresentable rather than something each
 * call site has to remember. It is a safety net, not a licence: the
 * convention this codebase already states — build the record without the
 * key rather than with an `undefined` value (`DynamoAssignmentStore.writeDecision`'s
 * own comment, and now patient-admin.ts's) — still holds, because "no
 * phone was given" and "phone is blank" are different facts and only the
 * call site knows which it means.
 */
function defaultDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

/**
 * Every attribute this table uses for *storage* rather than for domain
 * meaning — the base table's `pk`/`sk` and each GSI's own key pair.
 *
 * **The index keys were missing here until 2026-08-31, and their absence
 * was load-bearing by accident.** `gsi1pk`/`gsi1sk`/`gsi3pk`/`gsi3sk` live
 * as plain attributes on a patient's own `PROFILE` row
 * (assignment-repository.ts's `reassign` explains why, at length), so every
 * `Patient` read back through `withoutTableKeys` carried them into API
 * responses — and a later plain `put` of that same object happened to
 * re-write them, which is the only reason `PatientRepository.update` never
 * dropped a patient out of the caseload index. Stripping them turns that
 * accident into a real bug unless the write side derives them
 * deliberately, so the two changes land together:
 * `DynamoStoreOptions.indexAttributes` (below) is the write half.
 */
const TABLE_KEY_ATTRIBUTES = [
  'pk',
  'sk',
  'gsi1pk',
  'gsi1sk',
  'gsi2pk',
  'gsi2sk',
  'gsi3pk',
  'gsi3sk',
] as const;

/** Strips the table's storage-layer key attributes so callers only ever see domain fields. */
function withoutTableKeys<T>(row: Record<string, unknown>): T {
  const item = { ...row };
  for (const attribute of TABLE_KEY_ATTRIBUTES) {
    delete item[attribute];
  }
  return item as T;
}

/** Maps a `KeyValueStore<T>` key to this table's `pk`/`sk` attributes for one entity's single-item ("META") rows. */
export function singleItemKeys(pkPrefix: string): { pk(key: string): string; sk(): string } {
  return {
    pk: (key: string) => `${pkPrefix}#${key}`,
    sk: () => META_SORT_KEY,
  };
}

export interface DynamoStoreOptions<T> {
  readonly tableName: string;
  readonly keys: { pk(key: string): string; sk(key: string): string };
  /**
   * Derived, never stored on the domain object — the GSI key attributes
   * this entity projects itself into, recomputed from the item on every
   * write. `withoutTableKeys` (above) strips them on the way back out, so
   * these two halves are the *only* places an index key is ever written or
   * read; a caller cannot round-trip a stale one by accident, and cannot
   * drop one by forgetting to carry it forward.
   */
  readonly indexAttributes?: (item: T) => Record<string, string>;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoStore<T> implements KeyValueStore<T> {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly keys: DynamoStoreOptions<T>['keys'];
  private readonly indexAttributes: DynamoStoreOptions<T>['indexAttributes'];

  constructor(options: DynamoStoreOptions<T>) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
    this.keys = options.keys;
    this.indexAttributes = options.indexAttributes;
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
        Item: {
          ...item,
          ...(this.indexAttributes ? this.indexAttributes(item) : {}),
          pk: this.keys.pk(key),
          sk: this.keys.sk(key),
        },
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

// TASK 2.4.1: `PK = CLI#<sub>` / `SK = PROFILE`, per
// docs/plan/04-data-model-rbac.md's own row for this entity — the
// clinician-repository.ts header explains why the record is keyed by the
// Cognito `sub`. The singleton "exactly one principal" marker is a second,
// fixed-key row (`PK = CLI#PRINCIPAL_MARKER`), conditioned in the *same*
// transaction as the main item so the invariant holds even under
// concurrent creates.
//
// **Found live, 2026-08-28, the first real clinician sign-in ever
// attempted:** this file previously wrote `SK = META` here (the same
// `META_SORT_KEY` every non-profile entity in this file uses), which
// disagreed with dynamo-principal-directory.ts's own independently-written
// `PROFILE_SORT_KEY` — the authorizer's lookup key for *every* pool,
// correctly matching `PATIENT_PROFILE_SK` below. No test caught it because
// each side is well-tested in isolation; nothing before now exercised a
// real signed-in clinician end to end. The practical effect: every
// clinician account ever created, real or test, has been authorization-
// dead — `no-directory-record` on every request — since TASK 2.4.1
// shipped. `CLINICIAN_PROFILE_SK` is now its own named constant, matching
// `PATIENT_PROFILE_SK`'s own shape, rather than reusing the generic
// `META_SORT_KEY` that caused the drift.
const CLINICIAN_PK = (id: string) => `CLI#${id}`;
const CLINICIAN_PROFILE_SK = 'PROFILE';
const CLINICIAN_PRINCIPAL_MARKER_PK = 'CLI#PRINCIPAL_MARKER';
const CLINICIAN_PRINCIPAL_MARKER_SK = 'MARKER';

// 2026-08-31: the clinician *directory* — `GET /clinicians`, which the
// principal's dashboard needs to offer "reassign to…" as a list of real
// colleagues rather than a UUID typed in by hand. Same fixed-partition
// shape `TESTIMONIAL_INDEX#all`/`WORKSHOP_INDEX#all` already use on GSI2,
// and it can collide with neither of those nor with a content keyword's
// `KEYWORD#...`.
//
// **One deliberate divergence from those two: the index keys go on the
// `PROFILE` row itself, not on a separate `INDEX` row beside it.** A
// testimonial's index row exists because its main row is written by a
// plain overwrite that knows nothing about the projection; a clinician's
// projection is a pure function of `item.id`, so both writers below can
// derive it identically and there is nothing for a second row to protect
// against. It also keeps `list()` to one `Query` plus one `GetItem` per
// clinician rather than a `Query` that returns a row nobody wants.
const CLINICIAN_INDEX_GSI2PK = 'CLINICIAN_INDEX#all';
const clinicianIndexAttributes = (id: string) => ({
  gsi2pk: CLINICIAN_INDEX_GSI2PK,
  gsi2sk: CLINICIAN_PK(id),
});

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
        Key: { pk: CLINICIAN_PK(id), sk: CLINICIAN_PROFILE_SK },
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
    const mainItem = {
      ...item,
      ...clinicianIndexAttributes(item.id),
      pk: CLINICIAN_PK(item.id),
      sk: CLINICIAN_PROFILE_SK,
    };
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
        Item: {
          ...item,
          // Re-derived, not carried over from the caller's object — see
          // `clinicianIndexAttributes`. A deactivated clinician stays in
          // the directory on purpose: the principal has to be able to see
          // them in order to reactivate them.
          ...clinicianIndexAttributes(item.id),
          pk: CLINICIAN_PK(item.id),
          sk: CLINICIAN_PROFILE_SK,
        },
      }),
    );
  }

  /**
   * The whole directory, every status, in `CLI#<id>` order — one `Query`
   * against GSI2's fixed partition plus one `GetItem` per row (GSI2 is
   * KEYS_ONLY), never a `Scan`.
   *
   * Unpaginated, and deliberately: a clinician directory is a handful of
   * people, not a caseload — this is the one collection in the estate
   * whose whole extent genuinely fits one response. `LastEvaluatedKey` is
   * still followed rather than ignored, so "a handful" being wrong one
   * day is a slower call, not a silently truncated list.
   */
  async list(): Promise<Clinician[]> {
    const clinicians: Clinician[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const result: QueryCommandOutput = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI2_INDEX_NAME,
          KeyConditionExpression: 'gsi2pk = :indexKey',
          ExpressionAttributeValues: { ':indexKey': CLINICIAN_INDEX_GSI2PK },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const row of result.Items ?? []) {
        if (typeof row.pk !== 'string' || typeof row.sk !== 'string') {
          continue;
        }
        const item = await this.client.send(
          new GetCommand({ TableName: this.tableName, Key: { pk: row.pk, sk: row.sk } }),
        );
        if (item.Item) {
          clinicians.push(withoutTableKeys<Clinician>(item.Item));
        }
      }
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return clinicians;
  }
}

// TASK 2.5.1: `PK = PAT#<id>` / `SK = ASSIGNREQ#<ts>#<random>` for each
// decision row (the random suffix guards a same-millisecond collision the
// same way dynamo-audit-log.ts's does — low-odds here, given decisions
// are single-principal, human-paced actions, but cheap insurance and the
// established convention). The patient's own `PAT#<id>` / `PROFILE` row
// (patient-admin-handler.ts's key shape, unchanged) is overwritten in
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
//
// ## Amendment, 2026-08-31 — GSI3 indexes *every* patient, not only the
// assigned ones, and ranks them by status
//
// GSI3 was sparse on `assigned_clinician_id`, which made it exactly the
// wrong index for the principal's dashboard: the patients most needing an
// action — the ones just registered, still `pending`, with nobody
// responsible for them yet — were the precise set it could not return, so
// there was no way to reach "register a patient, then assign them" from a
// list at all. Now every `PROFILE` row carries a GSI3 projection, and the
// sort key leads with a status rank so DynamoDB's own index order puts
// operative patients on page one, ahead of pending and closed ones,
// without the read side sorting or filtering anything.
//
// `gsi3sk = <rank>#CLI#<clinicianId | UNASSIGNED>#PAT#<patientId>`. The
// `#PAT#` marker keeps its old meaning and its old parse
// (`split('#PAT#').pop()`); the clinician segment keeps grouping a
// clinician's patients together within a rank; `UNASSIGNED` is a literal,
// not an absent segment, so an unassigned patient sorts as a group of its
// own rather than colliding with a real clinician id (a Cognito sub —
// UUIDs, never this word).
//
// **This changes the shape of already-written rows**, which is why
// `scripts/backfill-directory-index.mjs` exists: rows written before this
// date carry the old, sparse projection and are invisible to the new
// queries until it is run once against the table.
const GSI3_INDEX_NAME = 'GSI3';
const GSI3_CASELOAD_PK = 'CASELOAD#all';
const GSI3_UNASSIGNED_CLINICIAN = 'UNASSIGNED';

/**
 * The status rank that leads `gsi3sk`. `approved` is what
 * `OPERATIVE_PATIENT_STATUSES` (shared-types) already means by an active
 * patient, so it sorts first; `pending` follows because it is the status
 * that most often needs the principal to do something; the two closed
 * states come last. Digits, not names, so the ordering is the number's,
 * not the English word's.
 */
const PATIENT_DIRECTORY_RANK: Readonly<Record<PatientAccountStatus, string>> = {
  approved: '0',
  pending: '1',
  suspended: '2',
  declined: '3',
};

/**
 * GSI3's projection for one patient — a pure function of the two fields it
 * reads, so no writer can put the index out of step with the record.
 * Exported because three call sites write a patient `PROFILE` row
 * (`DynamoStore<Patient>` in patient-handler.ts and
 * patient-admin-handler.ts, and `writeDecision` below) and all three must
 * derive it identically.
 */
export function patientDirectoryIndexAttributes(patient: Patient): {
  gsi3pk: string;
  gsi3sk: string;
} {
  const rank = PATIENT_DIRECTORY_RANK[patient.account_status];
  const clinicianId = patient.assigned_clinician_id ?? GSI3_UNASSIGNED_CLINICIAN;
  return {
    gsi3pk: GSI3_CASELOAD_PK,
    gsi3sk: `${rank}#CLI#${clinicianId}#PAT#${patient.id}`,
  };
}

/** The `gsi3sk` prefix that selects exactly the operative patients — the dashboard's own "active" count. */
const GSI3_ACTIVE_PREFIX = `${PATIENT_DIRECTORY_RANK.approved}#`;

/**
 * The patient `PROFILE` row's store, key shape and directory projection
 * together. Seven handlers construct a `PatientRepository`, and every one
 * of them repeated the same `PAT#<id>` / `PROFILE` key literals; now that
 * a write must also carry `patientDirectoryIndexAttributes`, "repeated
 * seven times" turns from duplication into a way to lose a patient out of
 * the dashboard by omission. One factory, so the projection is not
 * something a call site can forget.
 */
export function createPatientProfileStore(
  tableName: string,
  client?: DynamoDBDocumentClient,
): DynamoStore<Patient> {
  return new DynamoStore<Patient>({
    tableName,
    keys: { pk: (id: string) => PATIENT_PK(id), sk: () => PATIENT_PROFILE_SK },
    indexAttributes: patientDirectoryIndexAttributes,
    client,
  });
}

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
      // GSI3 is no longer sparse — every patient is in the directory, and
      // an unassigned one is precisely the row the dashboard most needs to
      // surface (see this section's 2026-08-31 amendment).
      ...patientDirectoryIndexAttributes(patient),
      pk: PATIENT_PK(patient.id),
      sk: PATIENT_PROFILE_SK,
    };
    // GSI1 stays sparse, derived from `assigned_clinician_id` alone — see
    // this section's header. Simply omitted (not set to `undefined`) when
    // there is no assignment, so a decline's `PutCommand` never tries to
    // marshall an explicit `undefined` value. Unlike GSI3, this index
    // answers "which patients belong to *this* clinician", a question an
    // unassigned patient has no answer to.
    if (patient.assigned_clinician_id) {
      patientItem.gsi1pk = GSI1_CLINICIAN_PK(patient.assigned_clinician_id);
      patientItem.gsi1sk = GSI1_PATIENT_SK(patient.id);
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
   * in the index's own order — active patients first, then grouped by
   * clinician within each status rank (`patientDirectoryIndexAttributes`).
   * Never a `Scan`, never more than `limit` items read, never a second page
   * fetched to build this one (step 5).
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
        // `<rank>#CLI#<clinicianId>#PAT#<patientId>` — the patient id is
        // everything after the last `#PAT#` marker; clinician ids are
        // Cognito subs (UUIDs, no `#`), so this is unambiguous, and the
        // rank prefix added on 2026-08-31 leaves the parse untouched.
        const patientId = gsi3sk.split('#PAT#').pop();
        if (patientId) {
          patientIds.push(patientId);
        }
      }
    }
    return { patientIds, nextCursor: encodeCaseloadCursor(result.LastEvaluatedKey) };
  }

  /**
   * "How many patients are in the system, and how many of those are
   * active" — two `Select: 'COUNT'` Queries over the same GSI3 partition
   * the page read above already uses, distinguished only by whether the
   * active rank prefix is required.
   *
   * `COUNT` still pages at DynamoDB's own 1MB boundary, so both loops
   * follow `LastEvaluatedKey` rather than trusting one round trip — on a
   * KEYS_ONLY index that is thousands of patients per page, so in practice
   * this is one call each.
   */
  async count(): Promise<{ total: number; active: number }> {
    const [total, active] = await Promise.all([
      this.countMatching(undefined),
      this.countMatching(GSI3_ACTIVE_PREFIX),
    ]);
    return { total, active };
  }

  private async countMatching(sortKeyPrefix: string | undefined): Promise<number> {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const result: QueryCommandOutput = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          IndexName: GSI3_INDEX_NAME,
          KeyConditionExpression: sortKeyPrefix
            ? 'gsi3pk = :caseloadKey AND begins_with(gsi3sk, :prefix)'
            : 'gsi3pk = :caseloadKey',
          ExpressionAttributeValues: {
            ':caseloadKey': GSI3_CASELOAD_PK,
            ...(sortKeyPrefix ? { ':prefix': sortKeyPrefix } : {}),
          },
          Select: 'COUNT',
          ExclusiveStartKey: startKey,
        }),
      );
      count += result.Count ?? 0;
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return count;
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
   * 2026-08-31: how many of this patient's appointments actually
   * happened. One `Query` on the patient's own partition, bounded by the
   * `APPT#` sort-key prefix — the same main-table read shape
   * `DynamoAppointmentStore.listForPatient` already uses, never a `Scan`
   * and never GSI1 (which is keyed by clinician, and this question has no
   * clinician in it).
   *
   * `appointment_status` is filtered in application code rather than by a
   * `FilterExpression`, and that is not laziness: a filter would still
   * read and charge for every row, so the only thing it would save is the
   * bytes over the wire, and doing it here keeps the definition of
   * "happened" — `completed`, never `scheduled`, `cancelled` or
   * `no-show` — visible next to the code that means it.
   */
  async countCompletedAppointments(patientId: string): Promise<number> {
    let count = 0;
    let startKey: Record<string, unknown> | undefined;
    do {
      const result: QueryCommandOutput = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :appointmentPrefix)',
          ExpressionAttributeValues: {
            ':patientKey': PATIENT_PK(patientId),
            ':appointmentPrefix': 'APPT#',
          },
          ExclusiveStartKey: startKey,
        }),
      );
      for (const row of result.Items ?? []) {
        if (row.appointment_status === 'completed') {
          count += 1;
        }
      }
      startKey = result.LastEvaluatedKey;
    } while (startKey);
    return count;
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

  /** TASK 4.2.1: one `GetItem` on the appointment's own key — see `AppointmentStore.get`'s own doc. */
  async get(patientId: string, scheduledAt: string): Promise<Appointment | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: PATIENT_PK(patientId), sk: APPOINTMENT_SORT_KEY(scheduledAt) },
      }),
    );
    return result.Item ? withoutTableKeys<Appointment>(result.Item) : undefined;
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
   * `appointment_status` alone (plus the two approval stamps) — never
   * `scheduledAt`, so `gsi1pk`/`gsi1sk` (derived from
   * `clinicianId`/`scheduledAt`) never need re-deriving. `ReturnValues:
   * 'ALL_NEW'` hands back the updated row in the same round trip a
   * separate `GetItem` would otherwise cost.
   *
   * **`expect` is enforced by the condition expression, not by a read
   * before the write**, which is what makes an approval race safe: two
   * principals acting on the same pending request at the same moment
   * produce one transition and one `APPOINTMENT_STATE_CONFLICT`, never two
   * transitions where the second overwrites the first.
   *
   * A failed condition cannot say *which* clause failed, so the row is
   * fetched once afterwards to tell "there is no such appointment" from
   * "it is no longer pending". That read happens only on the failure path
   * — the happy path is still one round trip.
   */
  async transition(
    patientId: string,
    scheduledAt: string,
    change: AppointmentTransition,
  ): Promise<Appointment> {
    const sk = APPOINTMENT_SORT_KEY(scheduledAt);
    const setsDecision = change.decidedBy !== undefined;
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: PATIENT_PK(patientId), sk },
          UpdateExpression: setsDecision
            ? 'SET appointment_status = :to, updated_at = :now, approvedBy = :by, approvedAt = :now'
            : 'SET appointment_status = :to, updated_at = :now',
          ConditionExpression: change.expect
            ? 'attribute_exists(pk) AND appointment_status = :expected'
            : 'attribute_exists(pk)',
          ExpressionAttributeValues: {
            ':to': change.to,
            ':now': change.now,
            ...(setsDecision ? { ':by': change.decidedBy } : {}),
            ...(change.expect ? { ':expected': change.expect } : {}),
          },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return withoutTableKeys<Appointment>(result.Attributes ?? {});
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        const existing = await this.get(patientId, scheduledAt);
        if (existing) {
          throw new AppError(
            'APPOINTMENT_STATE_CONFLICT',
            `appointment for patient ${patientId} at ${scheduledAt} is ${existing.appointment_status}, not ${change.expect}`,
          );
        }
        throw new AppError(
          'RECORD_NOT_FOUND',
          `no appointment for patient ${patientId} at ${scheduledAt}`,
        );
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

// TASK 3.6.1: `PAT#<id>` / `MSG#<created_at>#<id>` — the disambiguating
// suffix is the identical idiom `DynamoAuditLog`'s own sort key already
// establishes (`<iso-instant>#<newEventId()>`): the timestamp prefix gives
// the ordering, the suffix only has to be unique, so two messages sent in
// the same clinician↔patient thread within the same millisecond (a real
// possibility once this is genuinely bidirectional, per this task's own
// finding) can never collide.
const MESSAGE_SORT_KEY_PREFIX = 'MSG#';
const MESSAGE_SORT_KEY = (createdAt: string, id: string) => `MSG#${createdAt}#${id}`;

function encodeMessageCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) {
    return undefined;
  }
  return Buffer.from(JSON.stringify(key), 'utf-8').toString('base64url');
}

function decodeMessageCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8')) as Record<string, unknown>;
  } catch {
    throw new AppError('INVALID_CURSOR', 'cursor could not be decoded');
  }
}

export interface DynamoMessageStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
  /** Defaults to node:crypto's randomUUID — injectable so a test can force a key collision. */
  readonly newMessageId?: () => string;
}

export class DynamoMessageStore implements MessageStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly newMessageId: () => string;

  constructor(options: DynamoMessageStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
    this.newMessageId = options.newMessageId ?? randomUUID;
  }

  async create(message: Message): Promise<void> {
    const sk = MESSAGE_SORT_KEY(message.created_at, this.newMessageId());
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...message, pk: PATIENT_PK(message.patientId), sk },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'RECORD_ALREADY_EXISTS',
          `message collision for patient ${message.patientId} at ${sk}`,
        );
      }
      throw error;
    }
  }

  /** Main-table `Query`, never a `Scan` — ascending sort-key order threads the conversation oldest-first without a separate `ScanIndexForward` override. */
  async listForThread(
    patientId: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<MessagePage> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :messagePrefix)',
        ExpressionAttributeValues: {
          ':patientKey': PATIENT_PK(patientId),
          ':messagePrefix': MESSAGE_SORT_KEY_PREFIX,
        },
        Limit: limit,
        ExclusiveStartKey: decodeMessageCursor(cursor),
      }),
    );
    const items = (result.Items ?? []).map((item) => withoutTableKeys<Message>(item));
    return { items, nextCursor: encodeMessageCursor(result.LastEvaluatedKey) };
  }
}

// 2026-09-01: `PAT#<id>` / `NOTIF#<created_at>#<uuid>` — the patient's own
// in-app dashboard feed. The same time-prefix-plus-uuid sort key
// `DynamoMessageStore` above and `DynamoAuditLog` already use, and for the
// identical reason: the timestamp gives the ordering, the suffix only has
// to make two events in the same millisecond two rows.
//
// The suffix *is* `PatientNotification.notificationId`, so the row names
// its own key and `markRead` needs no parsing to find it again.
const NOTIFICATION_SORT_KEY = (notificationId: string) => `NOTIF#${notificationId}`;
const NOTIFICATION_SORT_KEY_PREFIX = 'NOTIF#';

export interface DynamoPatientNotificationStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoPatientNotificationStore implements PatientNotificationStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoPatientNotificationStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  async create(notification: PatientNotification): Promise<void> {
    const sk = NOTIFICATION_SORT_KEY(notification.notificationId);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...notification, pk: PATIENT_PK(notification.patientId), sk },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'RECORD_ALREADY_EXISTS',
          `notification collision for patient ${notification.patientId} at ${sk}`,
        );
      }
      throw error;
    }
  }

  /**
   * `ScanIndexForward: false` — newest first, which is the only order a
   * dashboard feed wants and is free here (DynamoDB reads the partition
   * backwards rather than sorting after the fact). `Limit` bounds the read
   * itself, so an old account with years of rows costs the same as a new
   * one; there is no cursor because nothing pages this view.
   */
  async listForPatient(patientId: string, limit: number): Promise<PatientNotification[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :notifPrefix)',
        ExpressionAttributeValues: {
          ':patientKey': PATIENT_PK(patientId),
          ':notifPrefix': NOTIFICATION_SORT_KEY_PREFIX,
        },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return (result.Items ?? []).map((item) => withoutTableKeys<PatientNotification>(item));
  }

  /**
   * `read` alone. A missing row is `undefined`, not a throw — a patient
   * dismissing a notice that is no longer there wanted it gone, and the
   * outcome they asked for is the outcome they have.
   */
  async markRead(
    patientId: string,
    notificationId: string,
    now: string,
  ): Promise<PatientNotification | undefined> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: PATIENT_PK(patientId), sk: NOTIFICATION_SORT_KEY(notificationId) },
          // `read` is a DynamoDB reserved word, hence the name placeholder.
          UpdateExpression: 'SET #read = :true, updated_at = :now',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeNames: { '#read': 'read' },
          ExpressionAttributeValues: { ':true': true, ':now': now },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return withoutTableKeys<PatientNotification>(result.Attributes ?? {});
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return undefined;
      }
      throw error;
    }
  }
}
