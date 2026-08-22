// TASK 2.4.1: the durable delivery log — `DeliveryLog`'s first
// implementation that outlives a Lambda invocation, built now because this
// task is the first production caller of `Notifier.send` (the clinician
// deactivation notice, clinician-admin.ts). `InMemoryDeliveryLog`
// (notification-log.ts) was correctly deferred at 2.3.1 — "nothing sends a
// real notification yet" — and this is "the gate that precedes its first
// real use," the same phrase 09-self-audit.md uses for every other
// deferred piece of this plan.
//
// Append-only by the same three mechanisms dynamo-audit-log.ts uses for
// the audit log: no update/removal method on the interface; the write is
// conditioned on `attribute_not_exists(pk)`; `attachDestructiveActionGuardrail`
// denies `dynamodb:DeleteItem` to every runtime role that touches this
// table. No read side exists — no task has asked for one yet, and this
// file does not build one ahead of that need.
import { randomUUID } from 'node:crypto';

import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';

import { AppError } from './errors.js';
import type { DeliveryLog, DeliveryRecord } from './notification-log.js';

const NOTIFICATION_PK_PREFIX = 'NOTIFICATION#';

/** `NOTIFICATION#<recipientId>` — one partition per recipient, not per day: nothing queries "all deliveries on date X" yet. */
export function notificationPartitionKey(recipientId: string): string {
  return `${NOTIFICATION_PK_PREFIX}${recipientId}`;
}

function defaultDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

export interface DynamoDeliveryLogOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
  /** Defaults to node:crypto's randomUUID — injectable so a test can force a key collision. */
  readonly newRecordId?: () => string;
}

export class DynamoDeliveryLog implements DeliveryLog {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  private readonly newRecordId: () => string;

  constructor(options: DynamoDeliveryLogOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
    this.newRecordId = options.newRecordId ?? randomUUID;
  }

  async append(record: DeliveryRecord): Promise<void> {
    const pk = notificationPartitionKey(record.recipientId);
    const sk = `${record.at}#${this.newRecordId()}`;
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          // Field by field, never `{ ...record }` — the same discipline
          // dynamo-audit-log.ts states for the same reason: this row can
          // never be amended or removed, so an accidental extra field
          // (e.g. a future caller hanging a message body off the object)
          // would be permanent.
          Item: {
            pk,
            sk,
            at: record.at,
            recipientId: record.recipientId,
            template: record.template,
            channel: record.channel,
            outcome: record.outcome,
            reason: record.reason,
          },
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new AppError(
          'DELIVERY_RECORD_ALREADY_EXISTS',
          `delivery record ${sk} already exists — delivery rows are append-only and cannot be overwritten`,
        );
      }
      throw error;
    }
  }
}
