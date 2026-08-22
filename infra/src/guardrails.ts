// IAM-layer half of the two-layer data-protection guard (TASK 0.3.2).
// The code-layer half (ndn/no-destructive-primitives) is TASK 0.3.1; its
// allowlist exists specifically so this file's Deny statements can be
// authored at all — see packages/eslint-plugin-no-destructive's
// no-destructive-primitives.js: an s3:DeleteObject* action string is only
// permitted under infra/ inside an object literal carrying
// effect: iam.Effect.DENY, which is exactly the PolicyStatementProps shape
// every statement below uses.

import { Stack } from 'aws-cdk-lib';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { AccountPrincipal, Effect, PolicyStatement, Role, type IRole } from 'aws-cdk-lib/aws-iam';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

// Wrapped in a Deny-shaped object literal (not a bare array) so this
// declaration itself satisfies ndn/no-destructive-primitives' allowlist —
// see the file-header comment. `actions` is the single source of truth;
// DENIED_DESTRUCTIVE_ACTIONS below just re-exports it flat for callers
// that only need the list, not a full statement template.
const DESTRUCTIVE_ACTIONS_DENY_TEMPLATE = {
  effect: Effect.DENY,
  actions: [
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    'dynamodb:DeleteItem',
    'dynamodb:DeleteTable',
  ],
} as const;

/** docs/plan/00-conventions.md's prohibition, expressed as IAM actions. */
export const DENIED_DESTRUCTIVE_ACTIONS: readonly string[] =
  DESTRUCTIVE_ACTIONS_DENY_TEMPLATE.actions;

export interface ProtectedResources {
  /** Buckets a runtime role must never be able to delete objects from. */
  readonly buckets: IBucket[];
  /** Tables a runtime role must never be able to delete items/itself from. */
  readonly tables: ITable[];
}

function protectedResourceArns(resources: ProtectedResources): string[] {
  return [
    ...resources.buckets.flatMap((bucket) => [bucket.bucketArn, `${bucket.bucketArn}/*`]),
    ...resources.tables.map((table) => table.tableArn),
  ];
}

/**
 * Identity-layer half of TASK 0.3.2 step 1: an explicit Deny on the four
 * destructive actions, scoped to the given resources. Explicit Deny always
 * wins over any Allow elsewhere in the same or any other attached policy
 * (AWS's policy evaluation logic), so this holds even if a future change
 * accidentally grants a broader Allow to the same role.
 */
export function denyDestructiveActionsStatement(resources: ProtectedResources): PolicyStatement {
  return new PolicyStatement({
    sid: 'DenyDestructivePrimitives',
    effect: Effect.DENY,
    actions: [...DENIED_DESTRUCTIVE_ACTIONS],
    resources: protectedResourceArns(resources),
  });
}

/**
 * Resource-layer half of TASK 0.3.2 step 2: the matching Deny expressed as
 * a bucket policy statement naming the runtime principal explicitly, so the
 * guard holds even if the role's own identity-based policy is ever
 * misconfigured (defence in depth — two independent evaluation paths have
 * to fail at once for a delete to succeed).
 */
export function denyBucketDeleteToPrincipalStatement(
  bucket: IBucket,
  principal: IRole,
): PolicyStatement {
  return new PolicyStatement({
    sid: 'DenyDeleteToRuntimePrincipal',
    effect: Effect.DENY,
    principals: [principal],
    actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
  });
}

/**
 * Attaches both halves of the guard to a real role + its buckets/tables.
 * Call this once the runtime role and its protected resources exist
 * (TASK 0.4.1 onward) — TASK 0.3.2 itself only proves the mechanism works
 * (see guardrails.test.ts and docs/runbooks/iam-deny-guardrails.md), since
 * no runtime role or protected resource is deployed yet.
 */
export function attachDestructiveActionGuardrail(role: IRole, resources: ProtectedResources): void {
  role.addToPrincipalPolicy(denyDestructiveActionsStatement(resources));
  for (const bucket of resources.buckets) {
    bucket.addToResourcePolicy(denyBucketDeleteToPrincipalStatement(bucket, role));
  }
}

/** Mirrors services/api/src/dynamo-audit-log.ts's `AUDIT#` partition prefix. */
export const AUDIT_PARTITION_KEY_PREFIX = 'AUDIT#';

/**
 * TASK 2.1.3 step 4: "the writer's IAM grant is `dynamodb:PutItem` only —
 * no read, no update — so a compromised writer cannot read the log it
 * appends to."
 *
 * On a single-table design that sentence needs a second half. Every
 * writing function already holds `grantReadData` on the same table for its
 * own entity's partitions (content, testimonials, workshops,
 * registrations), and a table-wide read grant reaches `AUDIT#<date>` as
 * surely as it reaches `CONTENT#<id>`. So the property is expressed the
 * only way a shared table allows: an explicit Deny on reads *whose
 * partition key starts with* `AUDIT#`, which outranks every Allow on the
 * role, plus an unconditional Deny on the two read shapes that carry no
 * partition key for the condition to match against.
 *
 * `dynamodb:LeadingKeys` is evaluated against the partition key values in
 * the request, so the conditioned statement covers GetItem/Query/
 * BatchGetItem (on the table and on every index). A Scan names no key at
 * all — the condition would simply not match and the Deny would not apply
 * — hence the second statement. Nothing in this repo scans or uses
 * PartiQL, so denying both costs nothing and closes the bypass.
 *
 * Not attached to the audit *reader* role, which is the one role that is
 * supposed to read this partition and holds no write permission at all.
 */
export function denyAuditPartitionReadStatements(table: ITable): PolicyStatement[] {
  const resources = [table.tableArn, `${table.tableArn}/index/*`];
  return [
    new PolicyStatement({
      sid: 'DenyAuditPartitionReads',
      effect: Effect.DENY,
      actions: ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem'],
      resources,
      conditions: {
        'ForAnyValue:StringLike': { 'dynamodb:LeadingKeys': [`${AUDIT_PARTITION_KEY_PREFIX}*`] },
      },
    }),
    new PolicyStatement({
      sid: 'DenyKeylessTableReads',
      effect: Effect.DENY,
      actions: ['dynamodb:Scan', 'dynamodb:PartiQLSelect'],
      resources,
    }),
  ];
}

/** Attaches {@link denyAuditPartitionReadStatements} to a role that writes audit rows but must never read them. */
export function attachAuditPartitionReadGuardrail(role: IRole, table: ITable): void {
  for (const statement of denyAuditPartitionReadStatements(table)) {
    role.addToPrincipalPolicy(statement);
  }
}

// Illustrative-only ARNs: no runtime role, bucket, or table is deployed yet
// (TASK 0.4.1 is the first task that deploys real ones). These exist so the
// guard's real-world behaviour can be proven against AWS's actual IAM
// policy simulator today, ahead of any real resource existing — see
// docs/runbooks/iam-deny-guardrails.md and infra/scripts/print-example-guardrail-policy.ts.
export const EXAMPLE_RUNTIME_BUCKET_ARN = 'arn:aws:s3:::ndn-example-media';
export const EXAMPLE_RUNTIME_TABLE_ARN =
  'arn:aws:dynamodb:eu-west-2:357601815388:table/ndn-example-data';

/**
 * The Deny statement above, combined with an illustrative baseline Allow
 * (the ordinary read/write permissions a real runtime role would carry),
 * as a plain IAM policy document — the exact shape `aws iam
 * simulate-custom-policy` accepts. `infra/src/__fixtures__/guardrails/
 * example-runtime-policy.json` is this function's output, checked in so CI
 * can feed it to the real policy simulator without needing a Node/pnpm
 * install step (see guardrails.test.ts's freshness test, which fails if
 * the checked-in file and this function ever diverge).
 */
export function buildExampleRuntimePolicyDocument() {
  const stack = new Stack();
  const bucket = Bucket.fromBucketArn(stack, 'ExampleBucket', EXAMPLE_RUNTIME_BUCKET_ARN);
  const table = Table.fromTableArn(stack, 'ExampleTable', EXAMPLE_RUNTIME_TABLE_ARN);
  const denyStatement = denyDestructiveActionsStatement({ buckets: [bucket], tables: [table] });
  return {
    Version: '2012-10-17',
    Statement: [
      denyStatement.toStatementJson(),
      {
        Sid: 'BaselineRuntimeAllow',
        Effect: 'Allow',
        Action: [
          's3:GetObject',
          's3:PutObject',
          's3:ListBucket',
          'dynamodb:GetItem',
          'dynamodb:PutItem',
          'dynamodb:Query',
        ],
        Resource: [
          EXAMPLE_RUNTIME_BUCKET_ARN,
          `${EXAMPLE_RUNTIME_BUCKET_ARN}/*`,
          EXAMPLE_RUNTIME_TABLE_ARN,
        ],
      },
    ],
  };
}

export interface BreakGlassRoleProps {
  /** The account the role lives in — the role is only assumable from within it. */
  readonly accountId: string;
}

/**
 * TASK 0.3.2 step 3: a separate, unused break-glass role. Its trust policy
 * requires MFA to assume (aws:MultiFactorAuthPresent) and it carries **no**
 * permissions — no addToPolicy call anywhere in this file grants it
 * anything. A human who genuinely needs to delete something attaches a
 * temporary policy by hand, out of band, after assuming this role with
 * MFA; that grant is never committed to this or any repo (00-conventions.md's
 * prohibition and DoD's "do not implement any break-glass deletion code
 * path" both hold precisely because the permission never appears in code).
 * See docs/runbooks/iam-deny-guardrails.md for the manual procedure.
 */
export class BreakGlassRole extends Role {
  constructor(scope: Construct, id: string, props: BreakGlassRoleProps) {
    super(scope, id, {
      roleName: 'ndn-break-glass',
      description:
        'Unused by default. Requires MFA to assume. No permissions attached in code — see docs/runbooks/iam-deny-guardrails.md.',
      assumedBy: new AccountPrincipal(props.accountId).withConditions({
        Bool: { 'aws:MultiFactorAuthPresent': 'true' },
      }),
    });
  }
}
