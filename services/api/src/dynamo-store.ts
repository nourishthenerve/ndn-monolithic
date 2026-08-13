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
import { DynamoDBClient, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { ContentItem } from '@ndn/shared-types';

import type { ContentStore } from './content-repository.js';
import { AppError } from './errors.js';
import type { KeyValueStore } from './store.js';

const META_SORT_KEY = 'META';
const CONTENT_PK = (id: string) => `CONTENT#${id}`;
// Used as both a keyword-projection row's own sort key and its GSI2
// partition key — same format, two different attributes (`sk` vs `gsi2pk`).
const KEYWORD_KEY = (keyword: string) => `KEYWORD#${keyword}`;
const GSI2_INDEX_NAME = 'GSI2';

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
}
