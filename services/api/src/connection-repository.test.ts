// TASK 4.1.1. Same aws-sdk-client-mock shape dynamo-principal-directory.test.ts
// uses — the real command objects, so the key shape and the TTL math this
// builds are asserted as they would reach DynamoDB.
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { DynamoConnectionRepository } from './connection-repository.js';

const TABLE_NAME = 'ndn-data';
const ddbMock = mockClient(DynamoDBDocumentClient);
const NOW = new Date('2026-08-26T12:00:00.000Z');
const clock: Clock = { now: () => NOW };

function repository() {
  return new DynamoConnectionRepository({
    tableName: TABLE_NAME,
    clock,
    client: ddbMock as unknown as DynamoDBDocumentClient,
  });
}

beforeEach(() => ddbMock.reset());
afterEach(() => ddbMock.reset());

describe('create', () => {
  it('writes exactly one row at CONN#<id> / PROFILE', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository().create({ connectionId: 'conn-1', principalId: 'sub-1', role: 'patient' });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Item: {
        pk: 'CONN#conn-1',
        sk: 'PROFILE',
        connectionId: 'conn-1',
        principalId: 'sub-1',
        role: 'patient',
        status: 'connected',
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      },
    });
  });

  it('sets ttl to created_at + 12h, in epoch seconds', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository().create({ connectionId: 'conn-1', principalId: 'sub-1', role: 'patient' });

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as { ttl: number };
    expect(item.ttl).toBe(Math.floor(NOW.getTime() / 1000) + 12 * 60 * 60);
  });

  it('carries no private key — this entity has no private{} half', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository().create({ connectionId: 'conn-1', principalId: 'sub-1', role: 'patient' });

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item.private).toBeUndefined();
  });

  it('is one PutItem, never a TransactWriteItems', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository().create({ connectionId: 'conn-1', principalId: 'sub-1', role: 'patient' });

    expect(ddbMock.calls()).toHaveLength(1);
  });
});

describe('markDisconnected', () => {
  it('sets status and disconnectedAt on the same row, never a second one', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repository().markDisconnected('conn-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: 'CONN#conn-1', sk: 'PROFILE' },
      UpdateExpression: 'SET #status = :disconnected, disconnectedAt = :now, updated_at = :now',
      ExpressionAttributeValues: { ':disconnected': 'disconnected', ':now': NOW.toISOString() },
    });
  });

  it('conditions on the row already existing, so it can never create one', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repository().markDisconnected('conn-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk)',
    );
  });

  it('is a no-op, not a thrown error, when the row is already gone', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(error);

    await expect(repository().markDisconnected('conn-1')).resolves.toBeUndefined();
  });

  it('propagates any other DynamoDB failure', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    await expect(repository().markDisconnected('conn-1')).rejects.toThrow();
  });

  it('never issues a DeleteItem', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repository().markDisconnected('conn-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.UpdateExpression).not.toMatch(
      /REMOVE/,
    );
  });
});

describe('findById', () => {
  it('is one GetItem at CONN#<id> / PROFILE', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { status: 'connected' } });
    await repository().findById('conn-1');

    expect(ddbMock.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: 'CONN#conn-1', sk: 'PROFILE' },
    });
  });

  it('returns undefined when there is no row', async () => {
    ddbMock.on(GetCommand).resolves({});

    expect(await repository().findById('conn-1')).toBeUndefined();
  });

  it('returns the row as found, disconnected or not', async () => {
    ddbMock.on(GetCommand).resolves({
      Item: {
        connectionId: 'conn-1',
        principalId: 'sub-1',
        role: 'patient',
        status: 'disconnected',
        disconnectedAt: '2026-08-26T13:00:00.000Z',
      },
    });

    expect(await repository().findById('conn-1')).toMatchObject({
      status: 'disconnected',
      disconnectedAt: '2026-08-26T13:00:00.000Z',
    });
  });
});

describe('recordCallJoin (TASK 4.2.1)', () => {
  it('writes one row at CALL#<appointmentId> / CONN#<connectionId>', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository().recordCallJoin({
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      connectionId: 'conn-1',
      principalId: 'sub-1',
      role: 'patient',
      ttl: 1_798_000_000,
    });

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Item: {
        pk: 'CALL#pat-1#2026-09-01T10:00:00.000Z',
        sk: 'CONN#conn-1',
        connectionId: 'conn-1',
        principalId: 'sub-1',
        role: 'patient',
        ttl: 1_798_000_000,
      },
    });
  });

  it('carries the ttl handed in, never recomputing its own', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository().recordCallJoin({
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      connectionId: 'conn-1',
      principalId: 'sub-1',
      role: 'sub-clinician',
      ttl: 42,
    });

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as { ttl: number };
    expect(item.ttl).toBe(42);
  });

  it('is one PutItem, never a TransactWriteItems', async () => {
    ddbMock.on(PutCommand).resolves({});
    await repository().recordCallJoin({
      appointmentId: 'pat-1#2026-09-01T10:00:00.000Z',
      connectionId: 'conn-1',
      principalId: 'sub-1',
      role: 'patient',
      ttl: 1,
    });

    expect(ddbMock.calls()).toHaveLength(1);
  });
});

describe('findCallParticipants (TASK 4.2.2)', () => {
  it('queries the CALL#<appointmentId> partition, nothing else', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await repository().findCallParticipants('pat-1#2026-09-01T10:00:00.000Z');

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'CALL#pat-1#2026-09-01T10:00:00.000Z' },
    });
  });

  it('returns every item the partition holds', async () => {
    const items = [
      { connectionId: 'conn-1', principalId: 'pat-1', role: 'patient', ttl: 1 },
      { connectionId: 'conn-2', principalId: 'cli-1', role: 'sub-clinician', ttl: 1 },
    ];
    ddbMock.on(QueryCommand).resolves({ Items: items });

    expect(await repository().findCallParticipants('pat-1#2026-09-01T10:00:00.000Z')).toEqual(items);
  });

  it('returns an empty array when nobody has joined', async () => {
    ddbMock.on(QueryCommand).resolves({});

    expect(await repository().findCallParticipants('pat-1#2026-09-01T10:00:00.000Z')).toEqual([]);
  });
});
