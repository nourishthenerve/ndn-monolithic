// TASK 2.1.3's Tests line, in order: every existing AuditAction round-trips
// through the Dynamo writer; a duplicate `<ts>#<id>` throws rather than
// overwriting; a failed audit write propagates and the caller's operation
// fails; a day's events come back in `<ts>` order from one query; and no
// audit row can carry a value from a record's `personal{}` or `clinical{}`
// half.
//
// The last one is asserted structurally rather than by scanning fixtures:
// `DynamoAuditLog.write` builds its item field by field, so an event object
// carrying anything extra persists nothing extra. That is a property of
// every row this system will ever write, which a fixture scan could not be.
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { BaseRecord } from '@ndn/shared-types';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  actorContext,
  auditEventFor,
  AUDIT_ACTIONS,
  hashSourceIp,
  type AuditEvent,
} from './audit.js';
import {
  auditDateOf,
  auditPartitionKey,
  DynamoAuditLog,
  DynamoAuditReader,
} from './dynamo-audit-log.js';
import { AppError } from './errors.js';
import { containsPrivateField } from './projection.js';
import { Repository } from './repository.js';
import { InMemoryStore } from './store.js';

const TABLE_NAME = 'ndn-data';
const ddbMock = mockClient(DynamoDBDocumentClient);

const ACTOR = actorContext(
  { subjectId: 'clinician-1', role: 'sub-clinician' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);

function eventAt(at: string, action: AuditEvent['action'] = 'create'): AuditEvent {
  return auditEventFor(ACTOR, { at, action, entityType: 'Patient', entityId: 'pat-1' });
}

function buildWriter(newEventId: () => string = () => 'id-1') {
  return new DynamoAuditLog({
    tableName: TABLE_NAME,
    client: ddbMock as unknown as DynamoDBDocumentClient,
    newEventId,
  });
}

beforeEach(() => {
  ddbMock.reset();
});

afterEach(() => {
  ddbMock.reset();
});

describe('auditDateOf', () => {
  it('is the UTC calendar day of the instant', () => {
    expect(auditDateOf('2026-08-21T23:59:59.999Z')).toBe('2026-08-21');
    expect(auditPartitionKey(auditDateOf('2026-08-21T00:00:00.000Z'))).toBe('AUDIT#2026-08-21');
  });

  it('refuses anything that is not a UTC instant, rather than deriving a partition nobody can query', () => {
    expect(() => auditDateOf('2026-08-21')).toThrow(AppError);
    expect(() => auditDateOf('21/08/2026')).toThrow(AppError);
    expect(() => auditDateOf('2026-08-21T10:00:00+01:00')).toThrow(AppError);
  });
});

describe('DynamoAuditLog.write', () => {
  it('writes docs/plan/04-data-model-rbac.md’s keys: AUDIT#<date> / <ts>#<id>', async () => {
    ddbMock.on(PutCommand).resolves({});
    await buildWriter(() => 'event-id-1').write(eventAt('2026-08-21T10:00:00.000Z'));

    expect(ddbMock.commandCalls(PutCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      Item: {
        pk: 'AUDIT#2026-08-21',
        sk: '2026-08-21T10:00:00.000Z#event-id-1',
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
  });

  it('round-trips every AuditAction the platform has', async () => {
    ddbMock.on(PutCommand).resolves({});
    const writer = buildWriter();

    for (const action of AUDIT_ACTIONS) {
      await writer.write(eventAt('2026-08-21T10:00:00.000Z', action));
    }

    const written = ddbMock
      .commandCalls(PutCommand)
      .map((call) => (call.args[0].input.Item as { action: string }).action);
    expect(written).toEqual([...AUDIT_ACTIONS]);
  });

  it('carries who, what, when and where — and the where is a hash, never the address', async () => {
    ddbMock.on(PutCommand).resolves({});
    await buildWriter().write(eventAt('2026-08-21T10:00:00.000Z', 'update'));

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(item).toMatchObject({
      at: '2026-08-21T10:00:00.000Z',
      actor: 'clinician-1',
      actorRole: 'sub-clinician',
      action: 'update',
      entityType: 'Patient',
      entityId: 'pat-1',
      requestId: 'req-1',
      sourceIpHash: hashSourceIp('198.51.100.7'),
    });
    expect(JSON.stringify(item)).not.toContain('198.51.100.7');
  });

  it('persists exactly ten attributes, so nothing personal or clinical can ride along', async () => {
    ddbMock.on(PutCommand).resolves({});
    // An event carrying both halves of a person record (person-record.ts)
    // plus a clinician-private attribute — the three things step 5 says an
    // audit row must never hold. None of them is a declared AuditEvent
    // field, so this can only happen through an object that widened
    // somewhere; the writer is what makes it harmless.
    const contaminated = {
      ...eventAt('2026-08-21T10:00:00.000Z'),
      personal: { name: 'Ada Lovelace', email: 'ada@example.com' },
      clinical: { diagnosis: 'a real diagnosis' },
      private: { note: 'a clinician-only note' },
    } as AuditEvent;

    await buildWriter().write(contaminated);

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    expect(Object.keys(item).sort()).toEqual([
      'action',
      'actor',
      'actorRole',
      'at',
      'entityId',
      'entityType',
      'pk',
      'requestId',
      'sk',
      'sourceIpHash',
    ]);
    expect(containsPrivateField(item)).toBe(false);
    expect(JSON.stringify(item)).not.toContain('Ada Lovelace');
    expect(JSON.stringify(item)).not.toContain('a real diagnosis');
  });

  it('writes no TTL attribute — an audit row never expires', async () => {
    ddbMock.on(PutCommand).resolves({});
    await buildWriter().write(eventAt('2026-08-21T10:00:00.000Z'));

    const item = ddbMock.commandCalls(PutCommand)[0]?.args[0].input.Item as Record<string, unknown>;
    for (const key of Object.keys(item)) {
      expect(key.toLowerCase()).not.toContain('ttl');
      expect(key.toLowerCase()).not.toContain('expire');
    }
  });

  it('throws on a duplicate <ts>#<id> rather than overwriting the row that is there', async () => {
    ddbMock.on(PutCommand).rejects(
      new ConditionalCheckFailedException({
        message: 'conditional request failed',
        $metadata: {},
      }),
    );

    await expect(buildWriter().write(eventAt('2026-08-21T10:00:00.000Z'))).rejects.toMatchObject({
      code: 'AUDIT_EVENT_ALREADY_EXISTS',
    });
  });

  it('exposes no method that amends or removes a row', () => {
    const methodNames = Object.getOwnPropertyNames(DynamoAuditLog.prototype);
    expect(methodNames).toEqual(['constructor', 'write']);
  });
});

// TASK 2.1.3 step 8: "if the audit write fails, the operation that
// triggered it fails too. An unauditable change to clinical data is worse
// than a rejected one."
describe('a failed audit write', () => {
  it('propagates out of the repository call that triggered it', async () => {
    ddbMock.on(PutCommand).rejects(new Error('DynamoDB is having a bad day'));
    const repository = new Repository<BaseRecord>(
      new InMemoryStore(),
      buildWriter(),
      { now: () => new Date('2026-08-21T10:00:00.000Z') },
      'Patient',
    );

    await expect(repository.create('pat-1', ACTOR, {})).rejects.toThrow(
      'DynamoDB is having a bad day',
    );
  });
});

describe('DynamoAuditReader.listByDate', () => {
  it('queries one partition and returns the day in <ts> order', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { ...eventAt('2026-08-21T09:00:00.000Z'), pk: 'AUDIT#2026-08-21', sk: 'a' },
        { ...eventAt('2026-08-21T11:00:00.000Z', 'update'), pk: 'AUDIT#2026-08-21', sk: 'b' },
      ],
    });

    const events = await new DynamoAuditReader({
      tableName: TABLE_NAME,
      client: ddbMock as unknown as DynamoDBDocumentClient,
    }).listByDate('2026-08-21');

    expect(ddbMock.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': 'AUDIT#2026-08-21' },
      ScanIndexForward: true,
    });
    expect(events.map((e) => e.at)).toEqual([
      '2026-08-21T09:00:00.000Z',
      '2026-08-21T11:00:00.000Z',
    ]);
    // pk/sk are storage, not domain — the read API returns the event.
    expect(Object.keys(events[0] ?? {})).not.toContain('pk');
  });

  it('follows every page — a busy day is not silently truncated at 1 MB', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ ...eventAt('2026-08-21T09:00:00.000Z'), pk: 'AUDIT#2026-08-21', sk: 'a' }],
        LastEvaluatedKey: { pk: 'AUDIT#2026-08-21', sk: 'a' },
      })
      .resolvesOnce({
        Items: [{ ...eventAt('2026-08-21T10:00:00.000Z'), pk: 'AUDIT#2026-08-21', sk: 'b' }],
      });

    const events = await new DynamoAuditReader({
      tableName: TABLE_NAME,
      client: ddbMock as unknown as DynamoDBDocumentClient,
    }).listByDate('2026-08-21');

    expect(events).toHaveLength(2);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(QueryCommand)[1]?.args[0].input).toMatchObject({
      ExclusiveStartKey: { pk: 'AUDIT#2026-08-21', sk: 'a' },
    });
  });

  it('refuses a date that is not yyyy-mm-dd rather than querying a partition that cannot exist', async () => {
    const reader = new DynamoAuditReader({
      tableName: TABLE_NAME,
      client: ddbMock as unknown as DynamoDBDocumentClient,
    });

    await expect(reader.listByDate('yesterday')).rejects.toMatchObject({
      code: 'INVALID_AUDIT_DATE',
    });
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });

  it('fails loudly on a corrupted row instead of returning an event with holes in it', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ pk: 'AUDIT#2026-08-21', sk: 'a', at: '2026-08-21T09:00:00.000Z' }],
    });

    await expect(
      new DynamoAuditReader({
        tableName: TABLE_NAME,
        client: ddbMock as unknown as DynamoDBDocumentClient,
      }).listByDate('2026-08-21'),
    ).rejects.toMatchObject({ code: 'MALFORMED_AUDIT_ROW' });
  });

  it('exposes no method that writes', () => {
    expect(Object.getOwnPropertyNames(DynamoAuditReader.prototype)).toEqual([
      'constructor',
      'listByDate',
    ]);
  });
});
