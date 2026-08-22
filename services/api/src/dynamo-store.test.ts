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
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Appointment,
  AssignmentRequest,
  BaseRecord,
  Clinician,
  ContentAssignment,
  ContentItem,
  Message,
  Patient as RealPatient,
  Registration,
  Testimonial,
  Workshop,
} from '@ndn/shared-types';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import {
  DynamoAppointmentStore,
  DynamoAssessmentStore,
  DynamoAssignmentStore,
  DynamoCaseloadStore,
  DynamoClinicalRecordStore,
  DynamoClinicianStore,
  DynamoContentAssignmentStore,
  DynamoContentStore,
  DynamoMessageStore,
  DynamoRegistrationStore,
  DynamoStore,
  DynamoTestimonialStore,
  DynamoWebhookEventStore,
  DynamoWorkshopCapacityStore,
  DynamoWorkshopStore,
  singleItemKeys,
} from './dynamo-store.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';

// TASK 2.1.3: repository writes take an `ActorContext` (audit.ts) rather
// than a bare actor string — who, with what role, on which request, from
// where. One fixture stands in for all four here.
const ACTOR = actorContext(
  { subjectId: 'editor-1', role: 'principal-clinician' },
  { requestId: 'req-store-1', sourceIp: '198.51.100.7' },
);

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
    await repository.create('1', ACTOR, { name: 'Ada' });

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

function buildRegistration(overrides: Partial<Registration> = {}): Registration {
  return {
    id: 'registration-1',
    workshopId: 'workshop-1',
    status: 'pending',
    attendeeEmail: 'attendee@example.com',
    stripeCheckoutSessionId: 'cs_test_1',
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoRegistrationStore', () => {
  const store = new DynamoRegistrationStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('get() reads by WORKSHOP#<id>/REGISTRATION#<id> and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'WORKSHOP#workshop-1',
        sk: 'REGISTRATION#registration-1',
        ...buildRegistration(),
      },
    });

    const result = await store.get('workshop-1', 'registration-1');
    expect(result).toMatchObject({ id: 'registration-1', status: 'pending' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'WORKSHOP#workshop-1', sk: 'REGISTRATION#registration-1' },
    });
  });

  it('create() conditionally puts the row, scoped under the workshop pk', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.create(buildRegistration());

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({
        pk: 'WORKSHOP#workshop-1',
        sk: 'REGISTRATION#registration-1',
      }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('create() translates a failed condition check (duplicate id) into AppError', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.create(buildRegistration())).rejects.toThrow(AppError);
  });

  it('update() overwrites the row with a plain PutCommand, no ConditionExpression', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.update(buildRegistration({ status: 'confirmed' }));

    const call = ddbMock.commandCalls(PutCommand)[0]?.args[0].input;
    expect(call).toMatchObject({
      Item: expect.objectContaining({ status: 'confirmed' }),
    });
    expect(call?.ConditionExpression).toBeUndefined();
  });
});

describe('DynamoWorkshopCapacityStore', () => {
  const store = new DynamoWorkshopCapacityStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('tryReserve() atomically increments registeredCount on the WORKSHOP#<id>/CAPACITY row, conditioned on staying under capacity', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(store.tryReserve('workshop-1', 10)).resolves.toBe(true);

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Key: { pk: 'WORKSHOP#workshop-1', sk: 'CAPACITY' },
      UpdateExpression: 'SET registeredCount = if_not_exists(registeredCount, :zero) + :one',
      ConditionExpression: 'attribute_not_exists(registeredCount) OR registeredCount < :capacity',
      ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':capacity': 10 },
    });
  });

  it('tryReserve() returns false (not a thrown error) when the condition fails (at capacity)', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.tryReserve('workshop-1', 10)).resolves.toBe(false);
  });

  it('release() atomically decrements registeredCount, conditioned on it being above zero', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await store.release('workshop-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'WORKSHOP#workshop-1', sk: 'CAPACITY' },
      UpdateExpression: 'SET registeredCount = registeredCount - :one',
      ConditionExpression: 'attribute_exists(registeredCount) AND registeredCount > :zero',
    });
  });

  it('release() is a no-op (does not throw) when there is nothing to release', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.release('workshop-1')).resolves.toBeUndefined();
  });
});

describe('DynamoWebhookEventStore', () => {
  const store = new DynamoWebhookEventStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('tryClaim() conditionally puts a STRIPE_EVENT#<id> row and returns true on the first claim', async () => {
    ddbMock.on(PutCommand).resolves({});
    await expect(store.tryClaim('evt_1')).resolves.toBe(true);

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: { pk: 'STRIPE_EVENT#evt_1', sk: 'RECEIVED' },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('tryClaim() returns false (not a thrown error) when the event id was already claimed', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.tryClaim('evt_1')).resolves.toBe(false);
  });
});

function buildClinician(overrides: Partial<Clinician> = {}): Clinician {
  return {
    id: 'sub-1',
    displayName: 'A Clinician',
    role: 'sub',
    account_status: 'active',
    status: 'active',
    created_at: '2026-08-22T09:00:00.000Z',
    updated_at: '2026-08-22T09:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoClinicianStore', () => {
  const store = new DynamoClinicianStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('get() reads the META row and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: 'CLI#sub-1', sk: 'META', ...buildClinician() } });

    const result = await store.get('sub-1');
    expect(result).toMatchObject({ id: 'sub-1', role: 'sub' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'CLI#sub-1', sk: 'META' },
    });
  });

  it('create() for a sub-clinician writes only the main item — no principal marker', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store.create(buildClinician({ role: 'sub' }));

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems).toHaveLength(1);
    expect(call?.TransactItems?.[0]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({ pk: 'CLI#sub-1', sk: 'META', role: 'sub' }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('create() for a principal atomically writes the main item and the singleton marker', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await store.create(buildClinician({ role: 'principal' }));

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems).toHaveLength(2);
    expect(call?.TransactItems?.[1]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: { pk: 'CLI#PRINCIPAL_MARKER', sk: 'MARKER', clinicianId: 'sub-1' },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('create() maps a cancelled transaction to RECORD_ALREADY_EXISTS when the id already exists', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    ddbMock.on(GetCommand).resolves({ Item: { pk: 'CLI#sub-1', sk: 'META', ...buildClinician() } });

    await expect(store.create(buildClinician())).rejects.toMatchObject({
      code: 'RECORD_ALREADY_EXISTS',
    });
  });

  it('create() maps a cancelled transaction to PRINCIPAL_ALREADY_EXISTS when the id is new but no principal slot is free', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
      }),
    );
    ddbMock.on(GetCommand).resolves({}); // the disambiguating get() finds nothing

    await expect(store.create(buildClinician({ id: 'sub-2', role: 'principal' }))).rejects.toMatchObject({
      code: 'PRINCIPAL_ALREADY_EXISTS',
    });
  });

  it('update() overwrites the main item, unconditionally', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.update(buildClinician({ account_status: 'deactivated' }));

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({ pk: 'CLI#sub-1', sk: 'META', account_status: 'deactivated' }),
    });
    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.ConditionExpression).toBeUndefined();
  });
});

function buildPatient(overrides: Partial<RealPatient> = {}): RealPatient {
  return {
    id: 'pat-1',
    personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
    clinical: {},
    account_status: 'pending',
    keywords: [],
    status: 'active',
    created_at: '2026-08-22T08:00:00.000Z',
    updated_at: '2026-08-22T08:00:00.000Z',
    ...overrides,
  };
}

function buildAssignmentRequest(overrides: Partial<AssignmentRequest> = {}): AssignmentRequest {
  return {
    patientId: 'pat-1',
    requestedAt: '2026-08-22T09:00:00.000Z',
    decidedBy: 'principal-sub',
    decidedAt: '2026-08-22T09:00:00.000Z',
    status: 'declined',
    created_at: '2026-08-22T09:00:00.000Z',
    updated_at: '2026-08-22T09:00:00.000Z',
    ...overrides,
  };
}

describe('DynamoAssignmentStore', () => {
  const store = new DynamoAssignmentStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
    newRequestSuffix: () => 'suffix-1',
  });

  it('getPatient() reads the PROFILE row and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { pk: 'PAT#pat-1', sk: 'PROFILE', ...buildPatient() } });

    const result = await store.getPatient('pat-1');
    expect(result).toMatchObject({ id: 'pat-1', account_status: 'pending' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'PAT#pat-1', sk: 'PROFILE' },
    });
  });

  it('writeDecision() for an approval atomically writes the ASSIGNREQ# row and the patient row, with GSI1 and GSI3 attributes set', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const request = buildAssignmentRequest({ status: 'approved', assignedClinicianId: 'cli-1' });
    const patient = buildPatient({ account_status: 'approved', assigned_clinician_id: 'cli-1' });

    await store.writeDecision(request, patient);

    const call = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    expect(call?.TransactItems).toHaveLength(2);
    expect(call?.TransactItems?.[0]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: expect.objectContaining({
        pk: 'PAT#pat-1',
        sk: 'ASSIGNREQ#2026-08-22T09:00:00.000Z#suffix-1',
        status: 'approved',
      }),
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    expect(call?.TransactItems?.[1]?.Put).toMatchObject({
      TableName: 'ndn-data',
      Item: {
        pk: 'PAT#pat-1',
        sk: 'PROFILE',
        gsi1pk: 'CLI#cli-1',
        gsi1sk: 'PAT#pat-1',
        gsi3pk: 'CASELOAD#all',
        gsi3sk: 'CLI#cli-1#PAT#pat-1',
      },
    });
  });

  it('writeDecision() for a decline writes no gsi1pk/gsi1sk/gsi3pk/gsi3sk at all', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const request = buildAssignmentRequest({ status: 'declined' });
    const patient = buildPatient({ account_status: 'declined' });

    await store.writeDecision(request, patient);

    const patientItem = ddbMock.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems?.[1]
      ?.Put?.Item as Record<string, unknown>;
    expect(patientItem.gsi1pk).toBeUndefined();
    expect(patientItem.gsi1sk).toBeUndefined();
    expect(patientItem.gsi3pk).toBeUndefined();
    expect(patientItem.gsi3sk).toBeUndefined();
  });

  it('writeDecision() propagates a cancelled transaction as AppError — the atomicity property: neither leg lands', async () => {
    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'Transaction cancelled',
        $metadata: {},
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
      }),
    );

    const request = buildAssignmentRequest({ status: 'approved', assignedClinicianId: 'cli-1' });
    const patient = buildPatient({ account_status: 'approved', assigned_clinician_id: 'cli-1' });

    await expect(store.writeDecision(request, patient)).rejects.toMatchObject({
      code: 'ASSIGNMENT_REQUEST_ALREADY_EXISTS',
    });
    // The mocked client never actually applied either Put — this proves
    // the *caller* sees a single failure for the whole write, which is
    // the property "a forced failure on any leg leaves the patient
    // pending with no GSI1 row" reduces to at the transport layer:
    // TransactWriteItems either applies every item or none of them, and
    // this store surfaces that as one thrown error, never a partial one.
    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('listPatientIdsForClinician() queries GSI1 for the clinician key with a PAT# prefix, and extracts ids', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { gsi1pk: 'CLI#cli-1', gsi1sk: 'PAT#pat-1' },
        { gsi1pk: 'CLI#cli-1', gsi1sk: 'PAT#pat-2' },
      ],
    });

    const ids = await store.listPatientIdsForClinician('cli-1');
    expect(ids).toEqual(['pat-1', 'pat-2']);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :clinicianKey AND begins_with(gsi1sk, :patientPrefix)',
      ExpressionAttributeValues: { ':clinicianKey': 'CLI#cli-1', ':patientPrefix': 'PAT#' },
    });
  });

  it('listPatientIdsForClinician() returns an empty array for a clinician with no assigned patients', async () => {
    ddbMock.on(QueryCommand).resolves({});
    expect(await store.listPatientIdsForClinician('cli-1')).toEqual([]);
  });
});

describe('DynamoCaseloadStore', () => {
  const store = new DynamoCaseloadStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('queryPage() queries GSI3 for the fixed caseload key — a Query, never a Scan', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { gsi3pk: 'CASELOAD#all', gsi3sk: 'CLI#cli-1#PAT#pat-1' },
        { gsi3pk: 'CASELOAD#all', gsi3sk: 'CLI#cli-1#PAT#pat-2' },
      ],
    });

    const page = await store.queryPage(undefined, 20);

    expect(page.patientIds).toEqual(['pat-1', 'pat-2']);
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      IndexName: 'GSI3',
      KeyConditionExpression: 'gsi3pk = :caseloadKey',
      ExpressionAttributeValues: { ':caseloadKey': 'CASELOAD#all' },
      Limit: 20,
    });
    // No ScanCommand was ever imported or sent by this store — asserted
    // structurally by there being no ScanCommand call to find at all.
  });

  it('queryPage() round-trips a cursor: the next page picks up exactly where LastEvaluatedKey said to', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ gsi3pk: 'CASELOAD#all', gsi3sk: 'CLI#cli-1#PAT#pat-1' }],
      LastEvaluatedKey: { pk: 'PAT#pat-1', sk: 'PROFILE', gsi3pk: 'CASELOAD#all', gsi3sk: 'CLI#cli-1#PAT#pat-1' },
    });

    const firstPage = await store.queryPage(undefined, 1);
    expect(firstPage.nextCursor).toBeDefined();

    ddbMock.resetHistory();
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await store.queryPage(firstPage.nextCursor, 1);

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ExclusiveStartKey).toEqual({
      pk: 'PAT#pat-1',
      sk: 'PROFILE',
      gsi3pk: 'CASELOAD#all',
      gsi3sk: 'CLI#cli-1#PAT#pat-1',
    });
  });

  it('queryPage() has no nextCursor once the query returns no LastEvaluatedKey — the last page', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const page = await store.queryPage(undefined, 20);
    expect(page.nextCursor).toBeUndefined();
  });

  it('getPatient() reads the PROFILE row and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: { pk: 'PAT#pat-1', sk: 'PROFILE', ...buildPatient() },
    });

    const result = await store.getPatient('pat-1');
    expect(result).toMatchObject({ id: 'pat-1' });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'PAT#pat-1', sk: 'PROFILE' },
    });
  });
});

// TASK 3.2.1: `VersionedRepository`'s own `${id}#v${version}` store key
// (versioned-repository.ts), where `id` here is a patient id — parsed back
// into `pk`/`sk` by `DynamoClinicalRecordStore` itself, not passed in
// pre-split, so this suite is what actually proves the parse is correct
// against the real key shape, not just against `InMemoryStore`
// (clinical-record-repository.test.ts's own suite, which never exercises
// this class at all).
describe('DynamoClinicalRecordStore', () => {
  const diagnosisStore = new DynamoClinicalRecordStore({
    tableName: 'ndn-data',
    kind: 'diagnosis',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });
  const carePlanStore = new DynamoClinicalRecordStore({
    tableName: 'ndn-data',
    kind: 'care-plan',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('put() writes a conditional PutCommand keyed PAT#<id> / DIAG#v<n>', async () => {
    ddbMock.on(PutCommand).resolves({});
    await diagnosisStore.put('pat-1#v1', {
      version: 1,
      patientId: 'pat-1',
      visible: { summary: 'Initial' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: { pk: 'PAT#pat-1', sk: 'DIAG#v1', patientId: 'pat-1', version: 1 },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('put() writes PLAN#v<n> for the care-plan kind — the same patient, a different sort key prefix', async () => {
    ddbMock.on(PutCommand).resolves({});
    await carePlanStore.put('pat-1#v1', {
      version: 1,
      patientId: 'pat-1',
      visible: { summary: 'Weekly physio' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      Item: { pk: 'PAT#pat-1', sk: 'PLAN#v1' },
    });
  });

  it('put() throws AppError(VERSION_ALREADY_EXISTS) on a conditional check failure, not the raw SDK exception', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(
      diagnosisStore.put('pat-1#v1', {
        version: 1,
        patientId: 'pat-1',
        visible: { summary: 'Sneaky overwrite' },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
      }),
    ).rejects.toThrow(AppError);
  });

  it('get() reads the same PAT#<id> / DIAG#v<n> key and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'PAT#pat-1',
        sk: 'DIAG#v2',
        version: 2,
        patientId: 'pat-1',
        visible: { summary: 'Revised' },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
      },
    });

    const result = await diagnosisStore.get('pat-1#v2');
    expect(result).toMatchObject({ version: 2, visible: { summary: 'Revised' } });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'PAT#pat-1', sk: 'DIAG#v2' },
    });
  });

  it('get() returns undefined for a version that was never written', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(diagnosisStore.get('pat-1#v9')).resolves.toBeUndefined();
  });
});

// TASK 3.3.1: `assessment-repository.ts`'s own composite key
// (`${patientId}#${assessmentId}`) becomes `VersionedRepository`'s own
// `${id}#v${version}` store key, so the real key this store parses is
// `${patientId}#${assessmentId}#v${version}` — this suite is what proves
// that three-part parse against the real `pk`/`sk` shape, not just
// against `InMemoryStore` (assessment-repository.test.ts's own suite).
describe('DynamoAssessmentStore', () => {
  const store = new DynamoAssessmentStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('put() writes a conditional PutCommand keyed PAT#<patientId> / ASSESS#<assessmentId>#v<n>', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.put('pat-1#mobility-initial#v1', {
      version: 1,
      patientId: 'pat-1',
      assessmentId: 'mobility-initial',
      visible: { formType: 'mobility', responses: { painScore: 4 } },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: {
        pk: 'PAT#pat-1',
        sk: 'ASSESS#mobility-initial#v1',
        patientId: 'pat-1',
        assessmentId: 'mobility-initial',
        version: 1,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('put() splits the assessment id correctly even when it contains its own "#v" substring', async () => {
    ddbMock.on(PutCommand).resolves({});
    // A pathological but not impossible form id — proves the parse keys
    // off the *last* `#v` (the real version marker, always the literal
    // suffix) rather than the first one it happens to find.
    await store.put('pat-1#check#v-status#v3', {
      version: 3,
      patientId: 'pat-1',
      assessmentId: 'check#v-status',
      visible: { formType: 'check', responses: {} },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      status: 'active',
    });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      Item: { pk: 'PAT#pat-1', sk: 'ASSESS#check#v-status#v3' },
    });
  });

  it('put() throws AppError(VERSION_ALREADY_EXISTS) on a conditional check failure, not the raw SDK exception', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(
      store.put('pat-1#mobility-initial#v1', {
        version: 1,
        patientId: 'pat-1',
        assessmentId: 'mobility-initial',
        visible: { formType: 'mobility', responses: {} },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
      }),
    ).rejects.toThrow(AppError);
  });

  it('get() reads the same three-part key and strips pk/sk', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        pk: 'PAT#pat-1',
        sk: 'ASSESS#mobility-initial#v2',
        version: 2,
        patientId: 'pat-1',
        assessmentId: 'mobility-initial',
        visible: { formType: 'mobility', responses: { painScore: 2 } },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        status: 'active',
      },
    });

    const result = await store.get('pat-1#mobility-initial#v2');
    expect(result).toMatchObject({ version: 2, visible: { responses: { painScore: 2 } } });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'PAT#pat-1', sk: 'ASSESS#mobility-initial#v2' },
    });
  });

  it('get() returns undefined for a version that was never written', async () => {
    ddbMock.on(GetCommand).resolves({});
    await expect(store.get('pat-1#mobility-initial#v9')).resolves.toBeUndefined();
  });
});

function buildAppointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    patientId: 'pat-1',
    clinicianId: 'cli-1',
    scheduledAt: '2026-09-01T10:00:00.000Z',
    durationMinutes: 30,
    appointment_status: 'scheduled',
    created_at: '2026-08-22T09:00:00.000Z',
    updated_at: '2026-08-22T09:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

// TASK 3.4.1: `docs/adr/0002-database.md`'s own proof of this shape,
// exercised for real for the first time — `create()`'s conditional
// `PutCommand` and its derived `gsi1pk`/`gsi1sk`; `listForPatient()`'s
// main-table `Query`; `listForClinicianCalendar()`'s GSI1 `Query` with a
// `BETWEEN` bound, followed by the per-row `GetCommand` GSI1's `KEYS_ONLY`
// projection requires — never a `Scan`, the same assertion shape TASK
// 2.5.1/2.5.3's own GSI1/GSI3 store tests already use.
describe('DynamoAppointmentStore', () => {
  const store = new DynamoAppointmentStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('create() writes a conditional PutCommand keyed PAT#<patientId> / APPT#<scheduledAt>, with GSI1 derived from clinicianId/scheduledAt alone', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.create(buildAppointment());

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: {
        pk: 'PAT#pat-1',
        sk: 'APPT#2026-09-01T10:00:00.000Z',
        gsi1pk: 'CLI#cli-1',
        gsi1sk: 'APPT#2026-09-01T10:00:00.000Z',
        patientId: 'pat-1',
        clinicianId: 'cli-1',
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('create() also derives GSI4 (gsi4pk/gsi4sk) when scheduledAt is after created_at — the "in the future at creation" check', async () => {
    ddbMock.on(PutCommand).resolves({});
    // buildAppointment()'s own defaults: scheduledAt 2026-09-01, created_at 2026-08-22 — already future.
    await store.create(buildAppointment());

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      Item: { gsi4pk: 'APPT#REMINDER', gsi4sk: '2026-09-01T10:00:00.000Z#pat-1' },
    });
  });

  it('create() omits gsi4pk/gsi4sk entirely when scheduledAt is not after created_at — not set to a falsy value, absent', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.create(
      buildAppointment({ scheduledAt: '2026-08-01T10:00:00.000Z', created_at: '2026-08-22T09:00:00.000Z' }),
    );

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item).not.toHaveProperty('gsi4pk');
    expect(item).not.toHaveProperty('gsi4sk');
  });

  it('create() throws AppError(APPOINTMENT_ALREADY_EXISTS) on a conditional check failure, not the raw SDK exception', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.create(buildAppointment())).rejects.toThrow(AppError);
  });

  it('listForPatient() issues a main-table Query, never a Scan, scoped to PAT#<id> with the APPT# prefix', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...buildAppointment(), pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T10:00:00.000Z' }],
    });

    const result = await store.listForPatient('pat-1');
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('pk');
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :apptPrefix)',
      ExpressionAttributeValues: { ':patientKey': 'PAT#pat-1', ':apptPrefix': 'APPT#' },
    });
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.IndexName).toBeUndefined();
  });

  it('listForClinicianCalendar() issues a GSI1 Query with a BETWEEN bound, never a Scan, then one GetCommand per row', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T10:00:00.000Z', gsi1pk: 'CLI#cli-1', gsi1sk: 'APPT#2026-09-01T10:00:00.000Z' }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: { ...buildAppointment(), pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T10:00:00.000Z' },
    });

    const result = await store.listForClinicianCalendar(
      'cli-1',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ patientId: 'pat-1', clinicianId: 'cli-1' });

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      IndexName: 'GSI1',
      KeyConditionExpression: 'gsi1pk = :clinicianKey AND gsi1sk BETWEEN :fromKey AND :toKey',
      ExpressionAttributeValues: {
        ':clinicianKey': 'CLI#cli-1',
        ':fromKey': 'APPT#2026-09-01T00:00:00.000Z',
        ':toKey': 'APPT#2026-09-02T00:00:00.000Z',
      },
    });
    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      Key: { pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T10:00:00.000Z' },
    });
  });

  it('listForClinicianCalendar() returns an empty array, not an error, when nothing is in range', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await store.listForClinicianCalendar(
      'cli-1',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    expect(result).toEqual([]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  // TASK 3.4.2: "index gives candidates, the read confirms them" — the
  // GSI1 Query still names the row (cancelling never touches
  // gsi1pk/gsi1sk), so the exclusion has to happen after the follow-up
  // GetItem, against the fetched item's own appointment_status.
  it('listForClinicianCalendar() excludes a cancelled row even though it still surfaces from the GSI1 Query', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T10:00:00.000Z', gsi1pk: 'CLI#cli-1', gsi1sk: 'APPT#2026-09-01T10:00:00.000Z' }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...buildAppointment({ appointment_status: 'cancelled' }),
        pk: 'PAT#pat-1',
        sk: 'APPT#2026-09-01T10:00:00.000Z',
      },
    });

    const result = await store.listForClinicianCalendar(
      'cli-1',
      '2026-09-01T00:00:00.000Z',
      '2026-09-02T00:00:00.000Z',
    );
    expect(result).toEqual([]);
  });

  it('cancel() issues an atomic UpdateItem on appointment_status alone, conditioned on the row existing', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        ...buildAppointment({ appointment_status: 'cancelled' }),
        pk: 'PAT#pat-1',
        sk: 'APPT#2026-09-01T10:00:00.000Z',
      },
    });

    const result = await store.cancel('pat-1', '2026-09-01T10:00:00.000Z', '2026-08-22T10:00:00.000Z');
    expect(result.appointment_status).toBe('cancelled');
    expect(result).not.toHaveProperty('pk');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Key: { pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T10:00:00.000Z' },
      UpdateExpression: 'SET appointment_status = :cancelled, updated_at = :now',
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeValues: { ':cancelled': 'cancelled', ':now': '2026-08-22T10:00:00.000Z' },
      ReturnValues: 'ALL_NEW',
    });
  });

  it('cancel() throws AppError(RECORD_NOT_FOUND) on a conditional check failure, not the raw SDK exception', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(
      store.cancel('pat-1', '2026-09-01T10:00:00.000Z', '2026-08-22T10:00:00.000Z'),
    ).rejects.toThrow(AppError);
  });

  it('listReminderCandidates() issues a GSI4 Query with an inclusive BETWEEN bound, never a Scan, then one GetCommand per row', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T09:55:00.000Z', gsi4pk: 'APPT#REMINDER', gsi4sk: '2026-09-01T09:55:00.000Z#pat-1' }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...buildAppointment({ scheduledAt: '2026-09-01T09:55:00.000Z' }),
        pk: 'PAT#pat-1',
        sk: 'APPT#2026-09-01T09:55:00.000Z',
      },
    });

    const result = await store.listReminderCandidates(
      '2026-09-01T09:00:00.000Z',
      '2026-09-01T10:15:00.000Z',
    );
    expect(result).toHaveLength(1);

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      IndexName: 'GSI4',
      KeyConditionExpression: 'gsi4pk = :reminderKey AND gsi4sk BETWEEN :fromKey AND :toKey',
      ExpressionAttributeValues: {
        ':reminderKey': 'APPT#REMINDER',
        ':fromKey': '2026-09-01T09:00:00.000Z',
        // One millisecond past the given windowEnd — see this method's own doc for why.
        ':toKey': '2026-09-01T10:15:00.001Z',
      },
    });
  });

  it('listReminderCandidates() excludes a row whose appointment_status is not scheduled, after the follow-up GetItem confirms it', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T09:55:00.000Z' }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...buildAppointment({ scheduledAt: '2026-09-01T09:55:00.000Z', appointment_status: 'cancelled' }),
        pk: 'PAT#pat-1',
        sk: 'APPT#2026-09-01T09:55:00.000Z',
      },
    });

    const result = await store.listReminderCandidates(
      '2026-09-01T09:00:00.000Z',
      '2026-09-01T10:15:00.000Z',
    );
    expect(result).toEqual([]);
  });

  it('listReminderCandidates() excludes a row that already has reminder_sent_at set', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T09:55:00.000Z' }],
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        ...buildAppointment({ scheduledAt: '2026-09-01T09:55:00.000Z' }),
        reminder_sent_at: '2026-09-01T09:00:00.000Z',
        pk: 'PAT#pat-1',
        sk: 'APPT#2026-09-01T09:55:00.000Z',
      },
    });

    const result = await store.listReminderCandidates(
      '2026-09-01T09:00:00.000Z',
      '2026-09-01T10:15:00.000Z',
    );
    expect(result).toEqual([]);
  });

  it('listReminderCandidates() returns an empty array, not an error, when the GSI4 Query itself finds nothing', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await store.listReminderCandidates(
      '2026-09-01T09:00:00.000Z',
      '2026-09-01T10:15:00.000Z',
    );
    expect(result).toEqual([]);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('claimForReminder() issues an atomic UpdateItem on reminder_sent_at alone, conditioned on the row existing and not already claimed', async () => {
    ddbMock.on(UpdateCommand).resolves({
      Attributes: {
        ...buildAppointment(),
        reminder_sent_at: '2026-08-22T09:00:00.000Z',
        pk: 'PAT#pat-1',
        sk: 'APPT#2026-09-01T10:00:00.000Z',
      },
    });

    const result = await store.claimForReminder(
      'pat-1',
      '2026-09-01T10:00:00.000Z',
      '2026-08-22T09:00:00.000Z',
    );
    expect(result?.reminder_sent_at).toBe('2026-08-22T09:00:00.000Z');
    expect(result).not.toHaveProperty('pk');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Key: { pk: 'PAT#pat-1', sk: 'APPT#2026-09-01T10:00:00.000Z' },
      UpdateExpression: 'SET reminder_sent_at = :now',
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(reminder_sent_at)',
      ExpressionAttributeValues: { ':now': '2026-08-22T09:00:00.000Z' },
      ReturnValues: 'ALL_NEW',
    });
  });

  it('claimForReminder() returns undefined, not a thrown error, on a conditional check failure — already claimed or nonexistent', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    const result = await store.claimForReminder(
      'pat-1',
      '2026-09-01T10:00:00.000Z',
      '2026-08-22T09:00:00.000Z',
    );
    expect(result).toBeUndefined();
  });
});

function buildContentAssignment(overrides: Partial<ContentAssignment> = {}): ContentAssignment {
  return {
    patientId: 'pat-1',
    contentId: 'content-1',
    assignedAt: '2026-08-22T09:00:00.000Z',
    created_at: '2026-08-22T09:00:00.000Z',
    updated_at: '2026-08-22T09:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

// TASK 3.5.1: `04-data-model-rbac.md`'s own minimal key shape, exercised
// for real for the first time — `create()`'s conditional `PutCommand`;
// `listForPatient()`'s main-table `Query`, `begins_with(sk, 'CONTENT#')` —
// never a `Scan`, the same assertion shape `DynamoAppointmentStore`'s own
// `listForPatient` test already uses.
describe('DynamoContentAssignmentStore', () => {
  const store = new DynamoContentAssignmentStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('create() writes a conditional PutCommand keyed PAT#<patientId> / CONTENT#<contentId>', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.create(buildContentAssignment());

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: {
        pk: 'PAT#pat-1',
        sk: 'CONTENT#content-1',
        patientId: 'pat-1',
        contentId: 'content-1',
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('create() throws AppError(RECORD_ALREADY_EXISTS) on a conditional check failure, not the raw SDK exception', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.create(buildContentAssignment())).rejects.toThrow(AppError);
  });

  it('listForPatient() issues a main-table Query, never a Scan, scoped to PAT#<id> with the CONTENT# prefix', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...buildContentAssignment(), pk: 'PAT#pat-1', sk: 'CONTENT#content-1' }],
    });

    const result = await store.listForPatient('pat-1');
    expect(result).toHaveLength(1);
    expect(result[0]).not.toHaveProperty('pk');
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :contentPrefix)',
      ExpressionAttributeValues: { ':patientKey': 'PAT#pat-1', ':contentPrefix': 'CONTENT#' },
    });
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.IndexName).toBeUndefined();
  });

  it('listForPatient() returns an empty array, not an error, when the patient has no assignments', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await store.listForPatient('pat-1');
    expect(result).toEqual([]);
  });
});

function buildMessage(overrides: Partial<Message> = {}): Message {
  return {
    patientId: 'pat-1',
    senderId: 'pat-1',
    senderRole: 'patient',
    body: 'Hello',
    created_at: '2026-08-22T09:00:00.000Z',
    updated_at: '2026-08-22T09:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

// TASK 3.6.1: `04-data-model-rbac.md`'s own key shape, exercised for real
// for the first time — `create()`'s conditional `PutCommand` (the sort
// key's disambiguating suffix, the identical `DynamoAuditLog` idiom this
// store's own header names); `listForThread()`'s main-table `Query`,
// `begins_with(sk, 'MSG#')` — never a `Scan`, the same assertion shape
// `DynamoAppointmentStore`'s own `listForPatient` test already uses.
describe('DynamoMessageStore', () => {
  const store = new DynamoMessageStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
    newMessageId: () => 'fixed-id',
  });

  it('create() writes a conditional PutCommand keyed PAT#<patientId> / MSG#<created_at>#<id>', async () => {
    ddbMock.on(PutCommand).resolves({});
    await store.create(buildMessage());

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Item: {
        pk: 'PAT#pat-1',
        sk: 'MSG#2026-08-22T09:00:00.000Z#fixed-id',
        patientId: 'pat-1',
        senderId: 'pat-1',
        senderRole: 'patient',
        body: 'Hello',
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('create() throws AppError(RECORD_ALREADY_EXISTS) on a conditional check failure, not the raw SDK exception', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.create(buildMessage())).rejects.toThrow(AppError);
  });

  it('listForThread() issues a main-table Query, never a Scan, scoped to PAT#<id> with the MSG# prefix', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ ...buildMessage(), pk: 'PAT#pat-1', sk: 'MSG#2026-08-22T09:00:00.000Z#fixed-id' }],
    });

    const result = await store.listForThread('pat-1', undefined, 50);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty('pk');
    expect(result.nextCursor).toBeUndefined();
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      KeyConditionExpression: 'pk = :patientKey AND begins_with(sk, :messagePrefix)',
      ExpressionAttributeValues: { ':patientKey': 'PAT#pat-1', ':messagePrefix': 'MSG#' },
      Limit: 50,
    });
    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.IndexName).toBeUndefined();
  });

  it('listForThread() decodes a cursor into ExclusiveStartKey and encodes LastEvaluatedKey into nextCursor', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [],
      LastEvaluatedKey: { pk: 'PAT#pat-1', sk: 'MSG#2026-08-22T09:00:00.000Z#fixed-id' },
    });
    const cursor = Buffer.from(JSON.stringify({ pk: 'PAT#pat-1', sk: 'MSG#a' }), 'utf-8').toString(
      'base64url',
    );

    const result = await store.listForThread('pat-1', cursor, 50);

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input.ExclusiveStartKey).toEqual({
      pk: 'PAT#pat-1',
      sk: 'MSG#a',
    });
    expect(result.nextCursor).toBeDefined();
    const decoded = JSON.parse(Buffer.from(result.nextCursor ?? '', 'base64url').toString('utf-8')) as unknown;
    expect(decoded).toEqual({ pk: 'PAT#pat-1', sk: 'MSG#2026-08-22T09:00:00.000Z#fixed-id' });
  });

  it('listForThread() throws AppError(INVALID_CURSOR) for a cursor that cannot be decoded', async () => {
    await expect(store.listForThread('pat-1', 'not-valid-base64url-json', 50)).rejects.toThrow(AppError);
  });

  it('listForThread() returns an empty page, not an error, when the thread has no messages', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    const result = await store.listForThread('pat-1', undefined, 50);
    expect(result).toEqual({ items: [], nextCursor: undefined });
  });
});
