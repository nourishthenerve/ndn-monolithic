import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { BaseRecord, ContentItem, Testimonial, Workshop } from '@ndn/shared-types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import {
  DynamoContentStore,
  DynamoStore,
  DynamoTestimonialStore,
  DynamoWorkshopStore,
  singleItemKeys,
} from './dynamo-store.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

describe('DynamoStore', () => {
  const store = new DynamoStore<{ name: string }>({
    tableName: 'ndn-data',
    keys: singleItemKeys('PAT'),
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('get() reads by the mapped pk/sk and strips them from the returned item', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: 'PAT#1', sk: 'META', name: 'Ada' } });

    const result = await store.get('1');

    expect(result).toEqual({ name: 'Ada' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Key: { pk: 'PAT#1', sk: 'META' },
    });
  });

  it('get() returns undefined when no item exists', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await store.get('missing')).toBeUndefined();
  });

  it('put() writes the item merged with the mapped pk/sk', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.put('1', { name: 'Ada' });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: { pk: 'PAT#1', sk: 'META', name: 'Ada' },
    });
  });
});

interface Patient extends BaseRecord {
  name: string;
}

describe('Repository backed by DynamoStore', () => {
  it('create()/findById() work unchanged against a DynamoStore in place of InMemoryStore', async () => {
    const store = new DynamoStore<Patient>({
      tableName: 'ndn-data',
      keys: singleItemKeys('PAT'),
      client: ddbMock as unknown as DynamoDBDocumentClient,
    });
    const repository = new Repository<Patient>(
      store,
      new InMemoryAuditLog(),
      fixedClock,
      'Patient',
    );

    ddbMock.on(GetCommand).resolves({});
    ddbMock.on(PutCommand).resolves({});
    await repository.create('1', 'clinician-1', { name: 'Ada' });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      Item: { pk: 'PAT#1', sk: 'META', name: 'Ada', status: 'active' },
    });

    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'PAT#1',
        sk: 'META',
        name: 'Ada',
        status: 'active',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
    });
    const found = await repository.findById('1');
    expect(found).toEqual({
      name: 'Ada',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    });
  });
});

function buildContentItem(overrides: Partial<ContentItem> = {}): ContentItem {
  return {
    id: 'content-1',
    contentType: 'blog',
    status: 'published',
    keywords: ['nutrition', 'diabetes'],
    translations: { en: { title: 'T', body: 'B', excerpt: 'E' } },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoContentStore', () => {
  const store = new DynamoContentStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('get() reads the META row and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'CONTENT#content-1', sk: 'META', ...buildContentItem() },
    });

    const result = await store.get('content-1');
    expect(result).toMatchObject({ id: 'content-1', status: 'published' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'CONTENT#content-1', sk: 'META' },
    });
  });

  it('create() atomically writes the main item and one row per keyword via TransactWriteItems', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const item = buildContentItem();
    await store.create(item);

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems).toHaveLength(3);
    expect(call?.TransactItems?.[0]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({ pk: 'CONTENT#content-1', sk: 'META' }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(call?.TransactItems?.[1]?.Put).toMatchObject({
      Item: {
        pk: 'CONTENT#content-1',
        sk: 'KEYWORD#nutrition',
        gsi2pk: 'KEYWORD#nutrition',
        gsi2sk: 'CONTENT#content-1',
      },
    });
    expect(call?.TransactItems?.[2]?.Put).toMatchObject({
      Item: {
        pk: 'CONTENT#content-1',
        sk: 'KEYWORD#diabetes',
        gsi2pk: 'KEYWORD#diabetes',
        gsi2sk: 'CONTENT#content-1',
      },
    });
  });

  it('create() translates a cancelled transaction (duplicate id) into AppError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );

    await expect(store.create(buildContentItem())).rejects.toThrow(AppError);
  });

  it('queryIdsByKeyword() queries GSI2 and extracts content ids from the returned pks', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { pk: 'CONTENT#content-1', sk: 'KEYWORD#nutrition' },
        { pk: 'CONTENT#content-2', sk: 'KEYWORD#nutrition' },
      ],
    });

    const ids = await store.queryIdsByKeyword('nutrition');
    expect(ids).toEqual(['content-1', 'content-2']);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :keyword',
      ExpressionAttributeValues: { ':keyword': 'KEYWORD#nutrition' },
    });
  });

  it('queryIdsByKeyword() returns an empty array when nothing matches', async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await store.queryIdsByKeyword('nonexistent')).toEqual([]);
  });

  it('update() overwrites the main item and re-puts one row per current keyword, with no ConditionExpression', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const item = buildContentItem({ keywords: ['nutrition'], status: 'unpublished' });
    await store.update(item);

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems).toHaveLength(2);
    expect(call?.TransactItems?.[0]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({ pk: 'CONTENT#content-1', sk: 'META', status: 'unpublished' }),
    });
    expect(call?.TransactItems?.[0]?.Put?.ConditionExpression).toBeUndefined();
    expect(call?.TransactItems?.[1]?.Put).toMatchObject({
      Item: {
        pk: 'CONTENT#content-1',
        sk: 'KEYWORD#nutrition',
        gsi2pk: 'KEYWORD#nutrition',
        gsi2sk: 'CONTENT#content-1',
      },
    });
  });

  it('update() never issues a DeleteItemCommand for a keyword dropped since the last write', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store.update(buildContentItem({ keywords: ['diet'] }));

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems?.every((entry) => entry.Delete === undefined)).toBe(true);
  });
});

function buildTestimonial(overrides: Partial<Testimonial> = {}): Testimonial {
  return {
    id: 'testimonial-1',
    status: 'pending_review',
    quote: { en: 'This service changed my recovery.' },
    attribution: { display: 'firstNameOnly', name: 'Jordan' },
    consent: {
      textVersion: '2026-08-14',
      consentedAt: '2026-01-01T00:00:00.000Z',
      submitterContactHash: 'hash-1',
    },
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoTestimonialStore', () => {
  const store = new DynamoTestimonialStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('get() reads the META row and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'TESTIMONIAL#testimonial-1', sk: 'META', ...buildTestimonial() },
    });

    const result = await store.get('testimonial-1');
    expect(result).toMatchObject({ id: 'testimonial-1', status: 'pending_review' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'TESTIMONIAL#testimonial-1', sk: 'META' },
    });
  });

  it('create() atomically writes the main item and one fixed "all testimonials" index row', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store.create(buildTestimonial());

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems).toHaveLength(2);
    expect(call?.TransactItems?.[0]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({ pk: 'TESTIMONIAL#testimonial-1', sk: 'META' }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(call?.TransactItems?.[1]?.Put).toMatchObject({
      Item: {
        pk: 'TESTIMONIAL#testimonial-1',
        sk: 'INDEX',
        gsi2pk: 'TESTIMONIAL_INDEX#all',
        gsi2sk: 'TESTIMONIAL#testimonial-1',
      },
    });
  });

  it('create() translates a cancelled transaction (duplicate id) into AppError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );

    await expect(store.create(buildTestimonial())).rejects.toThrow(AppError);
  });

  it('listAllIds() queries GSI2 for the fixed index key and extracts ids from the returned pks', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { pk: 'TESTIMONIAL#testimonial-1', sk: 'INDEX' },
        { pk: 'TESTIMONIAL#testimonial-2', sk: 'INDEX' },
      ],
    });

    const ids = await store.listAllIds();
    expect(ids).toEqual(['testimonial-1', 'testimonial-2']);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :indexKey',
      ExpressionAttributeValues: { ':indexKey': 'TESTIMONIAL_INDEX#all' },
    });
  });

  it('listAllIds() returns an empty array when nothing has ever been created', async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await store.listAllIds()).toEqual([]);
  });

  it('update() overwrites the main item, conditioned on consent matching the value being written', async () => {
    ddbMock.on(PutCommand).resolves({});
    const item = buildTestimonial({ status: 'published' });
    await store.update(item);

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({
        pk: 'TESTIMONIAL#testimonial-1',
        sk: 'META',
        status: 'published',
      }),
      ConditionExpression: 'consent = :expectedConsent',
      ExpressionAttributeValues: { ':expectedConsent': item.consent },
    });
  });

  it('update() translates a failed condition check (consent tampered with) into AppError', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.update(buildTestimonial())).rejects.toThrow(AppError);
  });
});

function buildWorkshop(overrides: Partial<Workshop> = {}): Workshop {
  return {
    id: 'workshop-1',
    status: 'published',
    dateTimeUtc: '2026-07-01T10:00:00.000Z',
    capacity: 20,
    priceMinorUnits: 2500,
    details: { en: { title: 'Balance & Falls Prevention', description: 'A hands-on workshop.' } },
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoWorkshopStore', () => {
  const store = new DynamoWorkshopStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('get() reads the META row and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'WORKSHOP#workshop-1', sk: 'META', ...buildWorkshop() },
    });

    const result = await store.get('workshop-1');
    expect(result).toMatchObject({ id: 'workshop-1', status: 'published' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'WORKSHOP#workshop-1', sk: 'META' },
    });
  });

  it('create() atomically writes the main item and one fixed "all workshops" index row', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store.create(buildWorkshop());

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems).toHaveLength(2);
    expect(call?.TransactItems?.[0]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({ pk: 'WORKSHOP#workshop-1', sk: 'META' }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(call?.TransactItems?.[1]?.Put).toMatchObject({
      Item: {
        pk: 'WORKSHOP#workshop-1',
        sk: 'INDEX',
        gsi2pk: 'WORKSHOP_INDEX#all',
        gsi2sk: 'WORKSHOP#workshop-1',
      },
    });
  });

  it('create() translates a cancelled transaction (duplicate id) into AppError', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );

    await expect(store.create(buildWorkshop())).rejects.toThrow(AppError);
  });

  it('listAllIds() queries GSI2 for the fixed index key and extracts ids from the returned pks', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { pk: 'WORKSHOP#workshop-1', sk: 'INDEX' },
        { pk: 'WORKSHOP#workshop-2', sk: 'INDEX' },
      ],
    });

    const ids = await store.listAllIds();
    expect(ids).toEqual(['workshop-1', 'workshop-2']);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      IndexName: 'GSI2',
      KeyConditionExpression: 'gsi2pk = :indexKey',
      ExpressionAttributeValues: { ':indexKey': 'WORKSHOP_INDEX#all' },
    });
  });

  it('listAllIds() returns an empty array when nothing has ever been created', async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await store.listAllIds()).toEqual([]);
  });

  it('update() overwrites the main item with a plain PutCommand, no ConditionExpression', async () => {
    ddbMock.on(PutCommand).resolves({});
    const item = buildWorkshop({ status: 'cancelled' });
    await store.update(item);

    const call = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(call).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({ pk: 'WORKSHOP#workshop-1', sk: 'META', status: 'cancelled' }),
    });
    expect(call?.ConditionExpression).toBeUndefined();
  });
});
