// D-22: "PITR **plus** periodic export to a separate object-locked
// prefix" — protection from an account-compromise scenario PITR alone
// would not survive (an attacker with the account's own credentials can
// disable PITR or delete the table; Object Lock's own retention holds
// even against that, because deleting or shortening a locked object's
// retention needs `s3:BypassGovernanceRetention`, granted to nobody by
// default — see below). Named by D-22 since before Phase 0; never built
// until now. TASK 5.4.1's own restore drill found this live, 2026-08-28
// (`docs/runbooks/restore-drill.md`): no matching S3 bucket, no `AWS
// Backup` plan, no EventBridge export rule existed anywhere in the
// account.
//
// **GOVERNANCE mode, not COMPLIANCE** — the one real decision this file
// makes that TASK 0.3.2's own break-glass precedent already answers.
// COMPLIANCE-mode retention cannot be shortened or bypassed by anyone,
// including the account root, until it expires — a genuinely permanent
// commitment for every object this pipeline ever writes. GOVERNANCE mode
// holds identically against every principal in this codebase (nothing
// here, or anywhere in this repository, is ever granted
// `s3:BypassGovernanceRetention`) but stays overridable through the
// existing `ndn-break-glass` role's own documented, MFA-gated, manual,
// never-committed-to-code procedure (`docs/runbooks/iam-deny-guardrails.md`)
// — the identical "protected by default, human-overridable under
// emergency procedure, never automatable" shape this codebase already
// uses for the destructive-primitive guard generally, applied here to a
// retention policy instead of a delete permission.
import { fileURLToPath } from 'node:url';

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { Effect, PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { BlockPublicAccess, Bucket, ObjectLockRetention } from 'aws-cdk-lib/aws-s3';
import type { Construct } from 'constructs';

import { attachDestructiveActionGuardrail } from './guardrails.js';
import { createLogGroup } from './log-retention.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));

/**
 * A full year, not PITR's own 35 days — D-22's own stated purpose is a
 * longer-horizon, different-threat-model backstop than PITR's continuous
 * recovery, not a duplicate of it. Named here as a real, disputable
 * choice (the same "named, disputable, not hidden" discipline
 * `derive-targets.ts` already applies to its own peak-traffic
 * assumptions) rather than picked silently.
 */
export const BACKUP_RETENTION_DAYS = 365;

/** Once a day: bounds worst-case data loss from this layer alone to under 24h, well inside D-21's own RPO target, without the cost or export-job volume of anything shorter. */
const EXPORT_SCHEDULE = Schedule.rate(Duration.days(1));

export function createBackupExportPipeline(scope: Construct, table: ITable): void {
  const exportBucket = new Bucket(scope, 'BackupExportBucket', {
    bucketName: `ndn-prod-backup-exports-${Stack.of(scope).account}`,
    // Object Lock requires versioning; CDK also refuses to synth without
    // it explicit here even though `objectLockDefaultRetention` implies
    // `objectLockEnabled: true` on its own.
    versioned: true,
    objectLockEnabled: true,
    objectLockDefaultRetention: ObjectLockRetention.governance(
      Duration.days(BACKUP_RETENTION_DAYS),
    ),
    blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    // Backup storage is never destroyed by this stack's own lifecycle —
    // the one bucket in this codebase where RemovalPolicy.RETAIN is the
    // entire point, not a defensive default.
    removalPolicy: RemovalPolicy.RETAIN,
  });

  const exportRole = new Role(scope, 'BackupExportFunctionRole', {
    assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  });

  const exportFunction = new NodejsFunction(scope, 'BackupExportFunction', {
    entry: `${moduleDir}../../services/api/src/backup-export-handler.ts`,
    handler: 'handler',
    runtime: Runtime.NODEJS_22_X,
    architecture: Architecture.ARM_64,
    memorySize: 128,
    // ExportTableToPointInTime only *starts* an export job — AWS runs it
    // asynchronously and this call returns as soon as the job is
    // accepted, so 30s is generous, not a bound on the export itself.
    timeout: Duration.seconds(30),
    role: exportRole,
    environment: {
      TABLE_ARN: table.tableArn,
      BACKUP_BUCKET_NAME: exportBucket.bucketName,
    },
    logGroup: createLogGroup(
      scope,
      'BackupExportFunctionLogGroup',
      '/ndn/backup-export-function',
      exportRole,
    ),
  });

  // Starting an export needs both halves: permission to ask DynamoDB for
  // one, and permission for whatever writes the result to land in the
  // bucket. AWS's own documented behaviour for ExportTableToPointInTime:
  // the *calling principal*'s own credentials are what the export uses to
  // write to S3, not a separate DynamoDB-owned service role — so this
  // role carries both grants, scoped as narrowly as each API allows.
  exportRole.addToPrincipalPolicy(
    new PolicyStatement({
      sid: 'StartTableExport',
      effect: Effect.ALLOW,
      actions: ['dynamodb:ExportTableToPointInTime', 'dynamodb:DescribeTable'],
      resources: [table.tableArn],
    }),
  );
  exportRole.addToPrincipalPolicy(
    new PolicyStatement({
      sid: 'WriteExportToBucket',
      effect: Effect.ALLOW,
      actions: ['s3:PutObject', 's3:AbortMultipartUpload'],
      resources: [`${exportBucket.bucketArn}/*`],
    }),
  );

  // No table-delete/item-delete permission is granted above in the first
  // place, and no S3 delete permission either — the guardrail below is
  // belt-and-braces on top of a role that already can't, matching every
  // other role in this codebase (`ContentReadFunctionRole` and its
  // siblings) rather than trusting the positive grant list alone.
  attachDestructiveActionGuardrail(exportRole, { buckets: [exportBucket], tables: [table] });
  // `s3:BypassGovernanceRetention` is deliberately never granted to any
  // principal, anywhere in this repository — see this file's own header.
  // An explicit Deny here would be redundant (nothing grants it), the
  // same reasoning `docs/runbooks/iam-deny-guardrails.md` already gives
  // for `ndn-break-glass` carrying zero permissions by construction
  // rather than a Deny nobody could otherwise violate.

  new Rule(scope, 'BackupExportSchedule', {
    schedule: EXPORT_SCHEDULE,
    targets: [new LambdaFunction(exportFunction)],
  });
}
