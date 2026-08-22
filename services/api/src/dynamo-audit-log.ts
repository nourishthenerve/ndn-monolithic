// TASK 2.1.3: the durable audit log — `AuditWriter`'s first implementation
// that outlives a Lambda invocation, and the read side that makes it
// reviewable.
//
// Keys are docs/plan/04-data-model-rbac.md's, unchanged: `PK =
// AUDIT#<yyyy-mm-dd>` / `SK = <iso-instant>#<id>`. Date-partitioned so a
// day's events are one query and no partition grows without bound — an
// audit log is the one table in this system that only ever gets longer.
//
// **Append-only, enforced three ways and not by convention.** The
// interface exposes no update and no removal (audit.ts); the write below
// is conditioned on `attribute_not_exists(pk)`, so a colliding key fails
// rather than overwrites; and `attachDestructiveActionGuardrail`
// (infra/src/guardrails.ts) denies `dynamodb:DeleteItem` to every runtime
// role that touches this table.
//
// **Writer and reader are separate classes on purpose.** TASK 2.1.3 step
// 4 grants the writer `dynamodb:PutItem` only — "so a compromised writer
// cannot read the log it appends to" — and the separation that enforces
// that is IAM, not TypeScript (infra/src/data-stack.ts: every writing
// function's role has no Query on this table; AuditReadFunction's role has
// no PutItem). The two classes here make the split visible in the code
// that the roles make real.
//
// **No TTL attribute is written, anywhere near this partition** (step 6).
// A row that expires is a row that disappears without anybody deciding it
// should.
import { randomUUID } from 'node:crypto';

import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditEvent,
  type AuditReader,
  type AuditWriter,
} from './audit.js';
import { AppError } from './errors.js';

const AUDIT_PK_PREFIX = 'AUDIT#';

/** `AUDIT#2026-08-21` — the partition one day of events lives in. */
export function auditPartitionKey(date: string): string {
  return `${AUDIT_PK_PREFIX}${date}`;
}

/** The `date=` query parameter's shape, and the tail of every partition key. */
export const AUDIT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Every `at` this writer sees comes from a Clock's `toISOString()`
// (00-conventions.md: "time is injectable"), so this only fires on a bug.
// It is checked anyway because the partition key is *derived* from it: a
// malformed instant would silently scatter a day's events across partitions
// that no `date=` query can name again, and an audit row nobody can find
// is an audit row that does not exist.
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;

/** The UTC calendar day an event belongs to, from its own instant. */
export function auditDateOf(at: string): string {
  if (!ISO_INSTANT_PATTERN.test(at)) {
    throw new AppError('INVALID_AUDIT_TIMESTAMP', `audit event timestamp is not a UTC instant`);
  }
  return at.slice(0, 'yyyy-mm-dd'.length);
}

function requireString(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') {
    throw new AppError(
      'MALFORMED_AUDIT_ROW',
      `audit row ${String(row.sk)} has no string "${field}"`,
    );
  }
  return value;
}

function requireAction(row: Record<string, unknown>): AuditAction {
  const value = requireString(row, 'action');
  const action = AUDIT_ACTIONS.find((candidate) => candidate === value);
  if (action === undefined) {
    throw new AppError('MALFORMED_AUDIT_ROW', `audit row ${String(row.sk)} has an unknown action`);
  }
  return action;
}

/**
 * Row → event, field by field rather than by stripping `pk`/`sk` off
 * whatever is stored (dynamo-store.ts's `withoutTableKeys` shape). Two
 * reasons: the read API then returns exactly the eight fields `AuditEvent`
 * declares and never an attribute some future writer added, and a
 * corrupted row is a loud failure rather than an event with an undefined
 * actor in it.
 */
function toAuditEvent(row: Record<string, unknown>): AuditEvent {
  return {
    at: requireString(row, 'at'),
    actor: requireString(row, 'actor'),
    actorRole: requireString(row, 'actorRole') as AuditEvent['actorRole'],
    action: requireAction(row),
    entityType: requireString(row, 'entityType'),
    entityId: requireString(row, 'entityId'),
    requestId: requireString(row, 'requestId'),
    sourceIpHash: requireString(row, 'sourceIpHash'),
  };
}

function defaultDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

export interface DynamoAuditLogOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
  /** Defaults to node:crypto's randomUUID — injectable so a test can force a key collision. */
  readonly newEventId?: () => string;
}

export class DynamoAuditLog implements AuditWriter {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly newEventId: () => string;

  constructor(options: DynamoAuditLogOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
    this.newEventId = options.newEventId ?? randomUUID;
  }

  /**
   * Appends one event. Throws on a key collision rather than overwriting,
   * and never catches its own failure: TASK 2.1.3 step 8 — "if the audit
   * write fails, the operation that triggered it fails too. An unauditable
   * change to clinical data is worse than a rejected one." Every caller is
   * a repository that awaits this after its store write, so a failure here
   * surfaces as the caller's failure, which is the intended behaviour.
   *
   * The sort key's ordering comes from the `<iso-instant>` prefix, so the
   * suffix only has to be unique. docs/plan/05-execution-plan.md says
   * `ulid`; `randomUUID` is in the Node runtime already and a ULID's own
   * property — lexicographic sortability — is the one thing the prefix
   * has covered. A dependency in every Lambda bundle for that would be a
   * dependency for nothing.
   */
  async write(event: AuditEvent): Promise<void> {
    const pk = auditPartitionKey(auditDateOf(event.at));
    const sk = `${event.at}#${this.newEventId()}`;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          // Field by field, never `{ ...event }`. TASK 2.1.3 step 5: "no
          // PII and no clinical content in an audit row — identifiers
          // only." A spread would persist whatever a caller happened to
          // hang off the object it passed, and the one row in this system
          // that can never be amended or removed is the last place to
          // find out that something extra came along. These ten keys are
          // the whole row; there is no eleventh.
          Item: {
            pk,
            sk,
            at: event.at,
            actor: event.actor,
            actorRole: event.actorRole,
            action: event.action,
            entityType: event.entityType,
            entityId: event.entityId,
            requestId: event.requestId,
            sourceIpHash: event.sourceIpHash,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'AUDIT_EVENT_ALREADY_EXISTS',
          `audit event ${sk} already exists — audit rows are append-only and cannot be overwritten`,
        );
      }
      throw error;
    }
  }
}

export interface DynamoAuditReaderOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoAuditReader implements AuditReader {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoAuditReaderOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  /**
   * One day, in `<ts>` order. One key condition on one partition — the
   * pagination loop is the SDK's own continuation of that single query,
   * not a second lookup: a busy day can exceed DynamoDB's 1 MB page and
   * an audit read that silently stopped at the first page would be a
   * review tool that lies by omission.
   */
  async listByDate(date: string): Promise<readonly AuditEvent[]> {
    if (!AUDIT_DATE_PATTERN.test(date)) {
      throw new AppError('INVALID_AUDIT_DATE', `audit date must be yyyy-mm-dd`);
    }
    const events: AuditEvent[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const page = await this.client.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk',
          ExpressionAttributeValues: { ':pk': auditPartitionKey(date) },
          ScanIndexForward: true,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      for (const row of page.Items ?? []) {
        events.push(toAuditEvent(row));
      }
      exclusiveStartKey = page.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return events;
  }
}
