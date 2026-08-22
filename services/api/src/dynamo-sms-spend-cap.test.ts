import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';

import { DynamoSpendCounterStore } from './dynamo-sms-spend-cap.js';
import { SMS_MONTHLY_CAP_PENCE } from './sms-spend-cap.js';

const ddbMock = mockClient(DynamoDBDocumentClient);

beforeEach(() => {
  ddbMock.reset();
});

describe('DynamoSpendCounterStore', () => {
  const store = new DynamoSpendCounterStore({
    tableName: 'ndn-data',
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });

  it('tryAdd() issues an atomic UpdateItem keyed SMS_SPEND#<monthKey>, conditioned against the pre-update total', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await expect(store.tryAdd('2026-08', 3, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(true);

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      TableName: 'ndn-data',
      Key: { pk: 'SMS_SPEND#2026-08', sk: 'COUNTER' },
      UpdateExpression: 'SET spentPence = if_not_exists(spentPence, :zero) + :amount',
      ConditionExpression: 'attribute_not_exists(spentPence) OR spentPence <= :capMinusAmount',
      ExpressionAttributeValues: { ':zero': 0, ':amount': 3, ':capMinusAmount': SMS_MONTHLY_CAP_PENCE - 3 },
    });
  });

  it('tryAdd() returns false, not a thrown error, when the conditional check fails (would exceed the cap)', async () => {
    ddbMock
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }));

    await expect(store.tryAdd('2026-08', 3, SMS_MONTHLY_CAP_PENCE)).resolves.toBe(false);
  });

  it('keeps independent counters per month key, by construction of the pk it writes', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await store.tryAdd('2026-08', 3, SMS_MONTHLY_CAP_PENCE);
    await store.tryAdd('2026-09', 3, SMS_MONTHLY_CAP_PENCE);

    const keys = ddbMock.commandCalls(UpdateCommand).map((call) => call.args[0].input.Key?.pk);
    expect(keys).toEqual(['SMS_SPEND#2026-08', 'SMS_SPEND#2026-09']);
  });

  it('propagates an unrelated SDK error rather than treating it as a cap rejection', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('network blip'));
    await expect(store.tryAdd('2026-08', 3, SMS_MONTHLY_CAP_PENCE)).rejects.toThrow('network blip');
  });
});
