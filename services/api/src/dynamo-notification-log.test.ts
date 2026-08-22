import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { DynamoDeliveryLog, notificationPartitionKey } from './dynamo-notification-log.js';
import { AppError } from './errors.js';
import type { DeliveryRecord } from './notification-log.js';

const TABLE_NAME = 'ndn-data';
const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

const RECORD: DeliveryRecord = {
  at: '2026-08-22T09:00:00.000Z',
  recipientId: 'clinician-1',
  template: 'clinicianDeactivated',
  channel: 'email',
  outcome: 'sent',
};

function buildLog(newRecordId: () => string = () => 'id-1') {
  return new DynamoDeliveryLog({
    tableName: TABLE_NAME,
    client: ddbMock as unknown as DynamoDBDocumentClient,
    newRecordId,
  });
}

describe('notificationPartitionKey', () => {
  it('prefixes the recipient id', () => {
    expect(notificationPartitionKey('clinician-1')).toBe('NOTIFICATION#clinician-1');
  });
});

describe('DynamoDeliveryLog', () => {
  it('appends exactly the eight fields a DeliveryRecord carries, never a spread of anything extra', async () => {
    ddbMock.on(PutCommand).resolves({});
    const log = buildLog();

    await log.append(RECORD);

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toEqual({
      TableName: TABLE_NAME,
      Item: {
        pk: 'NOTIFICATION#clinician-1',
        sk: '2026-08-22T09:00:00.000Z#id-1',
        at: RECORD.at,
        recipientId: RECORD.recipientId,
        template: RECORD.template,
        channel: RECORD.channel,
        outcome: RECORD.outcome,
        reason: undefined,
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('carries the reason field when the record has one', async () => {
    ddbMock.on(PutCommand).resolves({});
    const log = buildLog();

    await log.append({ ...RECORD, outcome: 'degraded', reason: 'Capped' });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item).toMatchObject({
      outcome: 'degraded',
      reason: 'Capped',
    });
  });

  it('throws AppError on a key collision rather than overwriting', async () => {
    ddbMock
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(buildLog().append(RECORD)).rejects.toThrow(AppError);
    await expect(buildLog().append(RECORD)).rejects.toMatchObject({
      code: 'DELIVERY_RECORD_ALREADY_EXISTS',
    });
  });

  it('propagates any other failure — never catches its own failure (same rule dynamo-audit-log.ts states)', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB is unavailable'));

    await expect(buildLog().append(RECORD)).rejects.toThrow('DynamoDB is unavailable');
  });
});
