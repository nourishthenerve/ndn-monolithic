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
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
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
   *
   * **2026-09-04: it also retires this principal's own earlier rows in the
   * same call, and that is the fix for a bug that made video calling
   * unusable.** The sort key is the `connectionId`, which is new on every
   * WebSocket connection — so every join, *including every page reload and
   * every earlier attempt at the same appointment*, left another permanent
   * row in this partition, alive for the 12 hours its `ttl` carries.
   * Nothing ever retired one: `$disconnect` and the relay's own
   * `GoneException` path both call `markDisconnected`, which updates
   * `CONN#<id>/PROFILE` — a *different row* — and leaves the `CALL#` row
   * exactly where it was.
   *
   * `ws-relay.ts` then picked "the other party" with a `find` over that
   * pile, which returns the first row in sort-key order: an arbitrary dead
   * connection from an earlier session. Every offer, answer and ICE
   * candidate went to a socket nobody was listening on, so both people saw
   * their own camera and nothing else — and because the `CALL#` row was
   * never retired, the next message chose the same dead row again.
   *
   * Retiring by `principalId` at join time is what makes this
   * deterministic rather than merely better: both parties open a fresh
   * connection for each call, so by the time the second one has joined,
   * each has exactly one live row and the partition holds exactly the two
   * of them.
   */
  recordCallJoin(input: RecordCallJoinInput): Promise<void>;
  /**
   * TASK 4.2.2: queries `CALL#<appointmentId>` — the same partition
   * `recordCallJoin` writes to — and hands every row back as-is,
   * `leftAt`-marked rows included. `ws-relay.ts`'s own job is deciding who,
   * if anyone, among these rows is live, which of them the sender is, and
   * who the other party is; this method makes no decision, it only reads.
   */
  findCallParticipants(appointmentId: string): Promise<CallParticipant[]>;
  /**
   * 2026-09-04: retires one participant's row in one call — the write that
   * was missing entirely. Called when a `PostToConnection` to that
   * participant comes back `GoneException`: their socket is provably gone,
   * and without this the relay re-selects the same dead row on the very
   * next message, forever.
   *
   * A mark, never a delete — `docs/adr` and this repository's own header
   * keep the same "no destructive primitives" discipline the connection
   * row's soft-disconnect already follows. Idempotent, and a no-op on a
   * row that has already gone.
   */
  markCallParticipantLeft(appointmentId: string, connectionId: string): Promise<void>;
  /**
   * TASK 4.4.2: marks a `CALL#` row's own `turnActive` flag once
   * `turn-credentials.ts` has issued a credential against it — never
   * cleared, the same "no destructive primitives" discipline this row's
   * own TTL reclaim already relies on for cleanup, so a call that has
   * used TURN once stays capped at one active relay for the rest of that
   * row's life, the conservative direction to err in.
   */
  markTurnActive(appointmentId: string, connectionId: string): Promise<void>;
}

export interface RecordCallJoinInput {
  readonly appointmentId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly role: Role;
  readonly ttl: number;
}

export interface CallParticipant {
  readonly connectionId: string;
  readonly principalId: string;
  readonly role: Role;
  /** TASK 4.4.1: already stored by `recordCallJoin` (epoch seconds), only exposed on the type from this task on — `turn-credentials.ts` is its first reader, checking a caller's own row is still unexpired before minting a credential against it. */
  readonly ttl: number;
  /** TASK 4.4.2: set by `markTurnActive` once this participant has been issued a TURN credential — absent (never `false`) until then. */
  readonly turnActive?: boolean;
  /**
   * 2026-09-04: set once this participant's connection is known to be gone
   * — a superseded row from an earlier join, or one whose socket answered
   * `GoneException`. Absent (never `false`) on a live row, so the presence
   * of the attribute is the whole test. `ws-relay.ts` never forwards to a
   * row carrying it.
   */
  readonly leftAt?: string;
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
    // Read before the write, so this join sees the pile it is replacing.
    // The partition is tiny by construction (two people, plus whatever
    // reloads they have done today), so this is one small Query.
    const existing = await this.findCallParticipants(input.appointmentId);

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

    // **This is the fix.** One principal, one live row per call. A person
    // rejoining — a reload, a second attempt, yesterday's test — has
    // superseded their own earlier connection by the act of opening this
    // one, and leaving those rows live is what let the relay pick a dead
    // socket as "the other party". Retired after the new row is written,
    // never before: a failure here must not leave this call with no row
    // for the person who just joined.
    //
    // Scoped to *this* principal's own rows. The other party's rows are
    // not this join's business — theirs are retired by their own join, by
    // the relay's `GoneException` path, or by the `ttl`.
    await Promise.all(
      existing
        .filter(
          (participant) =>
            participant.principalId === input.principalId &&
            participant.connectionId !== input.connectionId &&
            participant.leftAt === undefined,
        )
        .map((participant) =>
          this.markCallParticipantLeft(input.appointmentId, participant.connectionId),
        ),
    );
  }

  async markCallParticipantLeft(appointmentId: string, connectionId: string): Promise<void> {
    const nowIso = this.clock.now().toISOString();
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `CALL#${appointmentId}`, sk: `CONN#${connectionId}` },
          // Never creates a row that doesn't already exist — the same
          // guard `markDisconnected` and `markTurnActive` keep.
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: 'SET leftAt = :now',
          ExpressionAttributeValues: { ':now': nowIso },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        return;
      }
      throw error;
    }
  }

  async findCallParticipants(appointmentId: string): Promise<CallParticipant[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': `CALL#${appointmentId}` },
      }),
    );
    return (result.Items ?? []) as CallParticipant[];
  }

  async markTurnActive(appointmentId: string, connectionId: string): Promise<void> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `CALL#${appointmentId}`, sk: `CONN#${connectionId}` },
          // Never creates a row that doesn't already exist — the same
          // guard `markDisconnected` keeps, here because a credential is
          // only ever issued against a row `turn-credentials.ts` has
          // already confirmed is live.
          ConditionExpression: 'attribute_exists(pk)',
          UpdateExpression: 'SET turnActive = :true',
          ExpressionAttributeValues: { ':true': true },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
        return;
      }
      throw error;
    }
  }
}
