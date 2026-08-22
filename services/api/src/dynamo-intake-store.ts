// TASK 2.2.3: the transient row that carries a patient's name, phone and
// marketing preference from `POST /registrations` to the Post-Confirmation
// trigger — see registration.ts's `IntakeStore` for why it has to exist at
// all (TASK 2.2.1's pool holds one attribute, and it is the email).
//
// `REG#<sub>` / `INTAKE`, on the same table as everything else. Keyed by a
// `sub` only Cognito could have issued, so nothing but the trigger for
// that exact user can read it.
//
// **`take` overwrites, it does not delete.** 00-conventions.md's
// prohibition is absolute and this row is not an exception to it. What
// `take` does is replace the payload with a consumed marker: the row
// survives, so "this registration was completed" stays a fact, and the
// patient's name stops existing anywhere except `PersonRecord.personal{}`
// — which is where R-04's future erasure can reach it and here is not.
// Data minimisation and the delete prohibition point the same way for
// once.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import type { IntakeStore, RegistrationIntake } from './registration.js';

const INTAKE_SORT_KEY = 'INTAKE';

const intakePartitionKey = (subjectId: string) => `REG#${subjectId}`;

export interface DynamoIntakeStoreOptions {
  readonly tableName: string;
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoIntakeStore implements IntakeStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoIntakeStoreOptions) {
    this.tableName = options.tableName;
    this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async put(subjectId: string, intake: RegistrationIntake): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: intakePartitionKey(subjectId),
          sk: INTAKE_SORT_KEY,
          fullName: intake.fullName,
          email: intake.email,
          ...(intake.phone === undefined ? {} : { phone: intake.phone }),
          marketingOptIn: intake.marketingOptIn,
          consumed: false,
        },
      }),
    );
  }

  async take(subjectId: string): Promise<RegistrationIntake | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: intakePartitionKey(subjectId), sk: INTAKE_SORT_KEY },
      }),
    );

    const item = result.Item;
    if (!item || item.consumed === true) {
      // Already consumed reads as absent, which is what makes a Cognito
      // retry of the trigger harmless: the second run finds nothing, and
      // `PatientRepository.register` is idempotent anyway.
      return undefined;
    }

    // The payload goes before the caller can fail on it. `REMOVE` on named
    // attributes of a row that stays — not `DeleteItem`, which appears
    // nowhere in this repository.
    await this.client.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk: intakePartitionKey(subjectId), sk: INTAKE_SORT_KEY },
        UpdateExpression: 'SET consumed = :true REMOVE fullName, email, phone, marketingOptIn',
        ExpressionAttributeValues: { ':true': true },
      }),
    );

    return {
      fullName: String(item.fullName ?? ''),
      email: String(item.email ?? ''),
      phone: item.phone === undefined ? undefined : String(item.phone),
      marketingOptIn: item.marketingOptIn === true,
    };
  }
}
