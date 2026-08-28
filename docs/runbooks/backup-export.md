# D-22's periodic export layer: a daily, object-locked DynamoDB backup

**Date:** 2026-08-28 · **Decisions:** [D-22](../plan/01-decisions.md) · **Depends on:** 1.3.1 (the table, PITR)

## Status: built, live-diffed against production, deploy pending merge

D-22 named this since before Phase 0 — "PITR **plus** periodic export to a separate object-locked prefix." Nothing built it until TASK 5.4.1's own restore drill found the gap live, 2026-08-28 (`restore-drill.md`): no matching S3 bucket, no `AWS Backup` plan, no EventBridge export rule existed anywhere in `ndn-prod`. This closes it.

**Not yet live in production** — this deploys via the ordinary `deploy` job (`ci.yml`, OIDC via `ndn-deploy`) once merged to `main`, the same path every other change in this codebase takes. `aws cdk diff NdnDataStack` (admin profile, read-only, no state mutated) confirms the change is purely additive — no `[-]`, no replacement of any existing resource, including `DataTable` itself:

```text
Resources
[+] AWS::S3::Bucket BackupExportBucket
[+] AWS::S3::BucketPolicy BackupExportBucket/Policy
[+] AWS::IAM::Role BackupExportFunctionRole
[+] AWS::IAM::Policy BackupExportFunctionRole/DefaultPolicy
[+] AWS::Logs::LogGroup BackupExportFunctionLogGroup
[+] AWS::Lambda::Function BackupExportFunction
[+] AWS::Events::Rule BackupExportSchedule
[+] AWS::Lambda::Permission BackupExportSchedule/AllowEventRule...
```

## The one real decision this file makes: GOVERNANCE mode, not COMPLIANCE

S3 Object Lock has two retention modes. **COMPLIANCE** mode cannot be shortened or bypassed by anyone — including the AWS account root — until the retention period expires: a genuinely permanent commitment for every object this pipeline ever writes, for the full retention period, no exceptions, ever. **GOVERNANCE** mode holds identically against every principal in this codebase (nothing here, or anywhere in this repository, is ever granted `s3:BypassGovernanceRetention` — confirmed by a synth-level test, not merely asserted) but stays overridable through `ndn-break-glass`'s own existing, documented, MFA-gated, manual, never-committed-to-code procedure (`iam-deny-guardrails.md`) — the identical "protected by default, human-overridable under emergency procedure, never automatable" shape TASK 0.3.2's own destructive-primitive guard already uses, applied here to a retention policy instead of a delete permission. Chosen deliberately over COMPLIANCE: the failure mode of "we need to remove a backup and genuinely cannot, ever" is worse than the failure mode this codebase already accepts everywhere else — a protected default that a real, audited, human procedure can override in a genuine emergency.

**Retention: 365 days**, not PITR's own 35 — D-22's own stated purpose (protection from account compromise) is a longer-horizon, different-threat-model backstop than PITR's continuous recovery, not a duplicate of it. A disputable, named choice, not a hidden one (`derive-targets.ts`'s own "named, disputable, not hidden" precedent for its own assumptions).

## What was built

- **`infra/src/backup-export.ts`** — `createBackupExportPipeline(scope, table)`: the S3 bucket (Object Lock, GOVERNANCE, 365 days, versioned, `BlockPublicAccess.BLOCK_ALL`, `enforceSSL: true`, `RemovalPolicy.RETAIN` — the one bucket in this codebase where RETAIN is the entire point, not a defensive default), the export Lambda's own narrow role, and a daily `EventBridge` rule. Called from `data-stack.ts`, gated `if (!props.ephemeral)` — the identical gate `web-stack.ts` already uses for the email-events pipeline: a load-test/PR copy is destroyed within the hour, and a year-long object-locked backup of synthetic load-test traffic protects nothing.
- **`services/api/src/backup-export.ts`** — `runBackupExport`, SDK-free (an injected `startExport` dependency — no local/emulated equivalent of a real DynamoDB export exists to test against otherwise, the same reasoning `reminder-sweep.ts`/`reminder-sweep-handler.ts` already split on). `exportPrefix(now)` — one S3 prefix per calendar day (`exports/<YYYY-MM-DD>/`), so a duplicate/retried schedule tick overwrites rather than accumulating unbounded near-identical exports.
- **`services/api/src/backup-export-handler.ts`** — the real wiring: `DynamoDBClient`, `ExportTableToPointInTimeCommand`, `ExportFormat: 'DYNAMODB_JSON'`.
- **IAM, scoped narrowly**: `dynamodb:ExportTableToPointInTime` + `dynamodb:DescribeTable` on the table alone; `s3:PutObject` + `s3:AbortMultipartUpload` on the bucket alone. No delete permission on either resource is granted in the first place — `attachDestructiveActionGuardrail` (TASK 0.3.2) is applied on top anyway, belt-and-braces, matching every other role in this codebase rather than trusting the positive grant list alone.
- **`config.ts`** — `/ndn/backup-export-function` added to `UNMONITORED_LOG_GROUP_NAMES`: a fixed `rate(1 day)` schedule is the lowest, most predictable volume of any function in the estate, the same reasoning `reminder-sweep-function` already carries on that list.

## Verification

Synth-only, zero live AWS calls, `data-stack.test.ts`'s own new `describe('DataStack — backup export (D-22)')` block (6 tests): Object Lock enabled in GOVERNANCE mode at 365 days, versioned, `DeletionPolicy: Retain`; public access fully blocked; the EventBridge rule's `ScheduleExpression` is exactly `rate(1 day)`; the export role's own `StartTableExport`/`WriteExportToBucket` statements grant exactly the actions named above; **no statement anywhere in the synthesized stack grants `s3:BypassGovernanceRetention`** to any principal; the pipeline does not exist at all in an ephemeral (load-test) synth. `services/api/src/backup-export.test.ts` (5 tests): the date-prefix derivation, and that a failed export propagates rather than being silently swallowed.

The pre-existing structural guard from [log-retention-volume-control.md](log-retention-volume-control.md)'s own follow-up — "every hand-rolled Lambda role can write its own logs," walking the whole synthesized app — picked up `BackupExportFunctionRole` automatically the moment it existed, with no test file needing to name it individually. The first new caller of `createLogGroup`'s `grantee` parameter since that fix landed.

`pnpm -r lint && pnpm -r typecheck && pnpm --filter @ndn/infra run test && pnpm --filter @ndn/api run test` — all green (infra: 242 tests, 6 new; services/api: 5 new).

Live-verified, read-only, against production before this PR: `aws cdk synth NdnDataStack` succeeds; `aws cdk diff NdnDataStack` shown above, purely additive.

## What is still needed — owner action, once this deploys

1. **Confirm the first scheduled run.** `EXPORT_SCHEDULE` fires once daily; the first real export can also be triggered on demand via `aws lambda invoke --function-name <BackupExportFunction>`. Confirm a real object lands under `s3://ndn-prod-backup-exports-357601815388/exports/<date>/` and carries Object Lock metadata (`aws s3api get-object-retention`).
2. **Close TASK 5.4.1's own remaining gap.** `restore-drill.md`'s own step 5 — "restore D-22's periodic export into a scratch location and confirm it is readable" — was blocked because this pipeline didn't exist. Once a real export has run at least once, re-run that half of the drill: import the exported data into a scratch DynamoDB table (`ImportTableCommand`, the import-side twin of the export this task built) and verify it against known rows, the same discipline the PITR half of that drill already used.
3. **A CloudWatch alarm on export failure** was deliberately not built here — this task's own scope is the pipeline existing and running, not yet its own failure-alerting layer. A missed or failed daily export degrades silently until someone checks, the same honestly-named gap this codebase names elsewhere rather than leaves undiscussed. Worth its own small follow-up once the pipeline has a real run history to alarm against.

## Cost

Storage of a near-empty table's daily JSON export (a few KB/day at today's ~6-item table) plus one Lambda invocation/day, comfortably inside every existing free tier this account already relies on. Effectively £0.00 at current data volume — not separately broken out in `03-cost-model.md` for the same reason TASK 5.1.1's own one-off load-test cost wasn't: the amount is a rounding error against the account's own real month-to-date spend (`03-cost-model.md`'s own TASK 5.5.1 reconciliation, $0.49). Will need re-pricing once real patient/clinical data volume exists and the daily export is no longer near-empty — named here as a future reconciliation point, not silently assumed to stay free forever.
