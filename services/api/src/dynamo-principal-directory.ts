// TASK 2.2.2 step 4: "look up the account/record status once and put it in
// the Principal." One `GetItem`, on the key the subject's own record
// already has — no index, no scan, no second row to keep in step.
//
// **The key shape is a decision this task makes, and it constrains 2.4.1.**
// A patient's profile is `PAT#<cognito-sub>` / `PROFILE`, which is exactly
// what TASK 2.2.3 is specified to create ("keyed by the pool's `sub`"). For
// clinicians, TASK 2.4.1 writes the `CLI#` record *before* calling
// `AdminCreateUser`, so at the moment it writes there is no sub yet — which
// leaves three ways to link the two, and this file picks one:
//
//   - a custom Cognito attribute holding the record id — ruled out, TASK
//     2.2.1 put exactly one attribute on those pools and adding a second
//     would reopen "no personal data in the directory";
//   - a GSI on `cognito_sub` — a whole index, on the estate's smallest
//     partition, read once per cold authorisation;
//   - **key the `CLI#` record by the sub**, which costs 2.4.1 one
//     reordering: call `AdminCreateUser` first, then write `CLI#<sub>`.
//
// The third is chosen. 2.4.1's stated reason for writing the record first
// is that "an orphaned Cognito user is the failure mode rather than an
// orphaned record" — and that reason survives the reordering, because a
// Cognito user with no `CLI#` row is precisely what this file denies. The
// failure mode it wanted is the one it still gets.
//
// If a future task needs the original ordering back, it must add the link
// and change `keyFor` below; the constraint is here rather than implied.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import type { AccountStatus } from '@ndn/shared-types';

import type { DirectoryEntry, PrincipalDirectory } from './authorizer.js';
import type { TokenPool } from './jwt-verify.js';

const PROFILE_SORT_KEY = 'PROFILE';

/** Mirrors docs/plan/04-data-model-rbac.md's partition prefixes. */
const PARTITION_PREFIX: Record<TokenPool, string> = {
  patient: 'PAT#',
  clinician: 'CLI#',
};

const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  'pending',
  'approved',
  'declined',
  'suspended',
  'active',
  'deactivated',
];

function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}

export interface DynamoPrincipalDirectoryOptions {
  readonly tableName: string;
  /** Injectable for tests; defaults to a real document client. */
  readonly client?: DynamoDBDocumentClient;
}

export class DynamoPrincipalDirectory implements PrincipalDirectory {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(options: DynamoPrincipalDirectoryOptions) {
    this.tableName = options.tableName;
    this.client = options.client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}));
  }

  async lookup(pool: TokenPool, subjectId: string): Promise<DirectoryEntry | undefined> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: `${PARTITION_PREFIX[pool]}${subjectId}`, sk: PROFILE_SORT_KEY },
        // Exactly the two attributes an authorisation decision needs.
        // Not a whole record: a patient profile carries `personal{}` and
        // `clinical{}` halves (person-record.ts), and the authorizer has
        // no business holding either — it logs, and R-09's four exits
        // include "a log line".
        ProjectionExpression: 'account_status',
      }),
    );

    const item = result.Item;
    if (!item) {
      return undefined;
    }
    // A record whose status is absent or unrecognised is not a record this
    // system can authorise against. Denying is the only safe reading —
    // guessing `pending` would be inventing a lifecycle state, and
    // guessing `approved` would be granting one.
    if (!isAccountStatus(item.account_status)) {
      return undefined;
    }
    // `recordId` is the subject id by construction — see the key-shape
    // note at the top of this file. Derived from what was asked for
    // rather than read back from the item, so a record cannot claim to be
    // a different patient than the one whose key it sits under.
    return { recordId: subjectId, accountStatus: item.account_status };
  }
}
