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
  const APPOINTMENT_ID = 'pat-1#2026-09-01T10:00:00.000Z';

  /** No prior rows in the partition — the plain first-join case. */
  function noExistingParticipants() {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
  }

  it('writes one row at CALL#<appointmentId> / CONN#<connectionId>', async () => {
    noExistingParticipants();
    await repository().recordCallJoin({
      appointmentId: APPOINTMENT_ID,
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
    noExistingParticipants();
    await repository().recordCallJoin({
      appointmentId: APPOINTMENT_ID,
      connectionId: 'conn-1',
      principalId: 'sub-1',
      role: 'sub-clinician',
      ttl: 42,
    });

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as { ttl: number };
    expect(item.ttl).toBe(42);
  });

  it('writes exactly one row, never a TransactWriteItems', async () => {
    noExistingParticipants();
    await repository().recordCallJoin({
      appointmentId: APPOINTMENT_ID,
      connectionId: 'conn-1',
      principalId: 'sub-1',
      role: 'patient',
      ttl: 1,
    });

    expect(ddbMock.commandCalls(PutCommand)).toHaveLength(1);
    // 2026-09-04: the Query that reads the partition this join is about to
    // supersede itself in. One extra read, no extra write.
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  // 2026-09-04. **The bug this method now exists to prevent.** The sort key
  // is the connectionId, so every join — every reload, every earlier
  // attempt at the same appointment — left another permanent row here, and
  // `ws-relay.ts` picked "the other party" with a `find` over the pile.
  // Both people ended up talking to a dead socket and seeing only their own
  // camera. See the method's own note.
  describe('retiring this principal’s superseded rows', () => {
    function existing(items: readonly Record<string, unknown>[]) {
      ddbMock.on(QueryCommand).resolves({ Items: [...items] });
      ddbMock.on(PutCommand).resolves({});
      ddbMock.on(UpdateCommand).resolves({});
    }

    const rejoin = () =>
      repository().recordCallJoin({
        appointmentId: APPOINTMENT_ID,
        connectionId: 'conn-new',
        principalId: 'sub-1',
        role: 'patient',
        ttl: 100,
      });

    it('marks the same principal’s earlier connection as left', async () => {
      existing([{ connectionId: 'conn-old', principalId: 'sub-1', role: 'patient', ttl: 100 }]);
      await rejoin();

      expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
        TableName: TABLE_NAME,
        Key: { pk: `CALL#${APPOINTMENT_ID}`, sk: 'CONN#conn-old' },
        UpdateExpression: 'SET leftAt = :now',
        ExpressionAttributeValues: { ':now': NOW.toISOString() },
      });
    });

    it('retires every one of them, not only the first', async () => {
      existing([
        { connectionId: 'conn-a', principalId: 'sub-1', role: 'patient', ttl: 100 },
        { connectionId: 'conn-b', principalId: 'sub-1', role: 'patient', ttl: 100 },
      ]);
      await rejoin();
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(2);
    });

    it('leaves the other party’s row alone — theirs is not this join’s business', async () => {
      existing([{ connectionId: 'conn-them', principalId: 'cli-1', role: 'sub-clinician', ttl: 100 }]);
      await rejoin();
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('never retires the row it has just written', async () => {
      existing([{ connectionId: 'conn-new', principalId: 'sub-1', role: 'patient', ttl: 100 }]);
      await rejoin();
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('does not re-mark a row already retired', async () => {
      existing([
        {
          connectionId: 'conn-old',
          principalId: 'sub-1',
          role: 'patient',
          ttl: 100,
          leftAt: '2026-08-26T11:00:00.000Z',
        },
      ]);
      await rejoin();
      expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    it('writes the new row before retiring anything — a failure must never leave this join with no row', async () => {
      existing([{ connectionId: 'conn-old', principalId: 'sub-1', role: 'patient', ttl: 100 }]);
      await rejoin();

      const order = ddbMock.calls().map((call) => call.args[0].constructor.name);
      expect(order.indexOf('PutCommand')).toBeGreaterThan(-1);
      expect(order.indexOf('PutCommand')).toBeLessThan(order.indexOf('UpdateCommand'));
    });

    it('never issues a DeleteItem — a superseded row is marked, not removed', async () => {
      existing([{ connectionId: 'conn-old', principalId: 'sub-1', role: 'patient', ttl: 100 }]);
      await rejoin();
      expect(
        ddbMock.calls().filter((call) => call.args[0].constructor.name === 'DeleteCommand'),
      ).toHaveLength(0);
    });
  });
});

describe('markCallParticipantLeft (2026-09-04)', () => {
  const APPOINTMENT_ID = 'pat-1#2026-09-01T10:00:00.000Z';

  it('stamps leftAt on that participant’s own CALL# row', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repository().markCallParticipantLeft(APPOINTMENT_ID, 'conn-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      // The `CALL#` row, **not** `CONN#<id>/PROFILE` — confusing the two is
      // precisely what made the relay keep choosing a dead connection:
      // `markDisconnected` was updating the other row entirely.
      Key: { pk: `CALL#${APPOINTMENT_ID}`, sk: 'CONN#conn-1' },
      ConditionExpression: 'attribute_exists(pk)',
      UpdateExpression: 'SET leftAt = :now',
    });
  });

  it('is a no-op, not a thrown error, when the row is already gone', async () => {
    ddbMock.on(UpdateCommand).rejects(
      Object.assign(new Error('nope'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(
      repository().markCallParticipantLeft(APPOINTMENT_ID, 'conn-1'),
    ).resolves.toBeUndefined();
  });

  it('propagates any other DynamoDB failure', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('boom'));
    await expect(repository().markCallParticipantLeft(APPOINTMENT_ID, 'conn-1')).rejects.toThrow();
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

describe('markTurnActive (TASK 4.4.2)', () => {
  it('sets turnActive on the caller-specific CALL# row', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repository().markTurnActive('pat-1#2026-09-01T10:00:00.000Z', 'conn-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Key: { pk: 'CALL#pat-1#2026-09-01T10:00:00.000Z', sk: 'CONN#conn-1' },
      UpdateExpression: 'SET turnActive = :true',
      ExpressionAttributeValues: { ':true': true },
    });
  });

  it('conditions on the row already existing, so it can never create one', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repository().markTurnActive('pat-1#2026-09-01T10:00:00.000Z', 'conn-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression).toBe(
      'attribute_exists(pk)',
    );
  });

  it('is a no-op, not a thrown error, when the row is already gone', async () => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    ddbMock.on(UpdateCommand).rejects(error);

    await expect(
      repository().markTurnActive('pat-1#2026-09-01T10:00:00.000Z', 'conn-1'),
    ).resolves.toBeUndefined();
  });

  it('propagates any other DynamoDB failure', async () => {
    ddbMock.on(UpdateCommand).rejects(new Error('ProvisionedThroughputExceededException'));

    await expect(
      repository().markTurnActive('pat-1#2026-09-01T10:00:00.000Z', 'conn-1'),
    ).rejects.toThrow();
  });

  it('never issues a DeleteItem', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await repository().markTurnActive('pat-1#2026-09-01T10:00:00.000Z', 'conn-1');

    expect(ddbMock.commandCalls(UpdateCommand)[0]?.args[0].input.UpdateExpression).not.toMatch(
      /REMOVE/,
    );
  });
});
