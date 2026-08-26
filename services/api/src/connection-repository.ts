// TASK 4.1.1 step 4: the connection table's data layer. Deliberately the
// narrowest repository in this codebase — `create` and `markDisconnected`
// are each called exactly once, by their own dedicated handler
// (ws-connect-handler.ts / ws-disconnect-handler.ts); `findById` is the one
// capability a later Phase 4 task (the join message's call authorisation,
// TASK 4.2.1) needs to resolve a `connectionId` back to a principal. No
// `AuditWriter` dependency, unlike almost every other repository in this
// codebase: a connection row is operational metadata with no clinical
// content, not an entity the `AuditAction` union (audit.ts, TASK 2.1.3)
// needs to know about — the same distinction that task's own header draws
// between what gets audited and what does not.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Connection, Role } from '@ndn/shared-types';

import type { Clock } from './clock.js';

const SORT_KEY = 'PROFILE';

// The plan's own figure (TASK 4.1.1's Steps §3): "connectedAt + 12h" —
// long enough that a live call spanning the appointment window's own
// realistic bound never has its connection row disappear mid-call, short
// enough that a connection nobody ever disconnected is gone within a day.
const TTL_SECONDS = 12 * 60 * 60;

function keyFor(connectionId: string): { pk: string; sk: string } {
  return { pk: `CONN#${connectionId}`, sk: SORT_KEY };
}

export interface CreateConnectionInput {
  readonly connectionId: string;
  readonly principalId: string;
  readonly role: Role;
}

export interface ConnectionRepository {
  create(input: CreateConnectionInput): Promise<void>;
  /**
   * Never removes the row — sets `status: 'disconnected'` and stamps
   * `disconnectedAt` on the same row $connect created. A no-op (not an
   * error to the caller) if the row is already gone: $disconnect is not
   * guaranteed to fire before TTL could, in principle, have already swept
   * a very old row, and there is no client left to report a failure to.
   */
  markDisconnected(connectionId: string): Promise<void>;
  findById(connectionId: string): Promise<Connection | undefined>;
  /**
   * TASK 4.2.1: writes `CALL#<appointmentId>` / `CONN#<connectionId>` — a
   * second, thin row on the same table, only ever written by an
   * authorised, in-window join (`ws-join.ts`). `ttl` is passed in rather
   * than recomputed: "the same ttl 4.1.1's row carries" (the task's own
   * Steps §3) — a call row should never outlive the connection row it
   * points at, not gain a fresh 12h window of its own at join time.
   */
  recordCallJoin(input: RecordCallJoinInput): Promise<void>;
}

export interface RecordCallJoinInput {
  readonly appointmentId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly role: Role;
  readonly ttl: number;
}

export interface DynamoConnectionRepositoryOptions {
  readonly tableName: string;
  readonly clock: Clock;
  /** Injectable for tests; defaults to a real document client. */
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoConnectionRepository implements ConnectionRepository {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly clock: Clock;

  constructor(options: DynamoConnectionRepositoryOptions) {
    this.tableName = options.tableName;
    this.clock = options.clock;
    this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async create(input: CreateConnectionInput): Promise<void> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const item = {
      ...keyFor(input.connectionId),
      connectionId: input.connectionId,
      principalId: input.principalId,
      role: input.role,
      status: 'connected' as const,
      created_at: nowIso,
      updated_at: nowIso,
      ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
    } satisfies Connection & { pk: string; sk: string };

    await this.client.send(new PutCommand({ TableName: this.tableName, Item: item }));
  }

  async markDisconnected(connectionId: string): Promise<void> {
    const nowIso = this.clock.now().toISOString();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: keyFor(connectionId),
          // Never creates a row that doesn't already exist — UpdateItem
          // upserts by default, and a disconnect for a connection this
          // table never recorded (or has already TTL'd away) must stay
          // absent, not gain a phantom row with no connectedAt or ttl.
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: 'SET #status = :disconnected, disconnectedAt = :now, updated_at = :now',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':disconnected': 'disconnected', ':now': nowIso },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        return;
      }
      throw error;
    }
  }

  async findById(connectionId: string): Promise<Connection | undefined> {
    const result = await this.client.send(
      new GetCommand({ TableName: this.tableName, Key: keyFor(connectionId) }),
    );
    return result.Item as Connection | undefined;
  }

  async recordCallJoin(input: RecordCallJoinInput): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: `CALL#${input.appointmentId}`,
          sk: `CONN#${input.connectionId}`,
          connectionId: input.connectionId,
          principalId: input.principalId,
          role: input.role,
          ttl: input.ttl,
        },
      }),
    );
  }
}
