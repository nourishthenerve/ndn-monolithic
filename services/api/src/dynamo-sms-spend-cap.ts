// TASK 3.4.3: the durable monthly SMS spend counter — `sms-spend-cap.ts`'s
// own header named this file before it existed: "a DynamoDB-backed
// implementation can satisfy [SpendCounterStore] identically once the
// notification service actually sends anything." This is that task —
// the first one that gives `appointmentReminder1Hour` (the only
// `smsEligible` template) a real caller.
//
// `InMemorySpendCounterStore` is correct but *ephemeral* — every other
// wiring of `createSmsSender` in this codebase (assignment-handler.ts,
// clinician-admin-handler.ts) uses it, and that has always been safe
// because neither handler's own templates are ever `smsEligible`: the
// guard is wired only to satisfy `NotifierDeps`'s type, never actually
// reached. `reminder-sweep-handler.ts` is different — it is the one
// caller that *will* reach the SMS path for real, on a schedule
// (`rate(15 minutes)`) where a Lambda execution environment reused
// between ticks is the exception, not the guarantee. An in-memory
// counter on that cadence would reset to zero on most ticks, which
// would not enforce C-02's £5 hard cap at all — the exact "spend
// theoretical, not real" gap this task's own Cost line names directly.
// This store is what makes the cap durable across cold starts, the same
// way `dynamo-audit-log.ts`/`dynamo-notification-log.ts` made their own
// logs durable at the point each first had a real caller.
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import type { SpendCounterStore } from './sms-spend-cap.js';

const SMS_SPEND_PK_PREFIX = 'SMS_SPEND#';
const SMS_SPEND_COUNTER_SK = 'COUNTER';

function defaultDocumentClient(): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({}));
}

export interface DynamoSpendCounterStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoSpendCounterStore implements SpendCounterStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoSpendCounterStoreOptions) {
    this.client = options.client ?? defaultDocumentClient();
    this.tableName = options.tableName;
  }

  /**
   * Atomic: the `ConditionExpression` checks the *pre*-update total
   * against `capPence - amountPence` — DynamoDB conditions see the row
   * as it stood before this update, so this is the only way to express
   * "commit only if the post-update total would not exceed the cap"
   * without a separate read (which a concurrent writer could race
   * between). The identical shape `DynamoWorkshopCapacityStore.tryReserve`
   * already uses for its own capacity check (`dynamo-store.ts`).
   */
  async tryAdd(monthKey: string, amountPence: number, capPence: number): Promise<boolean> {
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { pk: `${SMS_SPEND_PK_PREFIX}${monthKey}`, sk: SMS_SPEND_COUNTER_SK },
          UpdateExpression: 'SET spentPence = if_not_exists(spentPence, :zero) + :amount',
          ConditionExpression: 'attribute_not_exists(spentPence) OR spentPence <= :capMinusAmount',
          ExpressionAttributeValues: {
            ':zero': 0,
            ':amount': amountPence,
            ':capMinusAmount': capPence - amountPence,
          },
        }),
      );
      return true;
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) {
        return false;
      }
      throw error;
    }
  }
}
