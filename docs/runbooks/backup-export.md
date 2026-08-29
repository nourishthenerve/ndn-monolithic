# D-22's periodic export layer: a daily, object-locked DynamoDB backup

**Date:** 2026-08-28, live and verified 2026-08-29 · **Decisions:** [D-22](../plan/01-decisions.md) · **Depends on:** 1.3.1 (the table, PITR)

## Status: built, deployed, and exercised for real — D-22 closed in full

D-22 named this since before Phase 0 — "PITR **plus** periodic export to a separate object-locked prefix." Nothing built it until TASK 5.4.1's own restore drill found the gap live, 2026-08-28 (`restore-drill.md`): no matching S3 bucket, no `AWS Backup` plan, no EventBridge export rule existed anywhere in `ndn-prod`. Built the same day, deployed via [#122](https://github.com/nourishthenerve/ndn-monolithic/pull/122) on merge, and exercised for real (a live export, a live import-and-verify restore) the next day — see "Status update, 2026-08-29" below.

`aws cdk diff NdnDataStack` (admin profile, read-only, no state mutated), taken before this PR merged, confirmed the change was purely additive — no `[-]`, no replacement of any existing resource, including `DataTable` itself:

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

## Status update, 2026-08-29 — items 1 and 2 below done for real

**Deployed via [#122](https://github.com/nourishthenerve/ndn-monolithic/pull/122), then exercised for real the same day** — triggered on demand (`aws lambda invoke`, ahead of the first scheduled tick) rather than waiting for `rate(1 day)` to fire on its own:

- A real export completed: **6 items, 1,560 bytes — an exact match to the live table**, landing at `s3://ndn-prod-backup-exports-357601815388/exports/2026-08-29/AWSDynamoDB/01787990334662-cdf7a008/`.
- `aws s3api get-object-retention` on a real exported object confirmed Object Lock working end to end, not just configured: `Mode: GOVERNANCE`, `RetainUntilDate: 2027-08-29` — exactly 365 days out.
- `restore-drill.md`'s own remaining item closed the same day: the export was imported into a scratch table (`ImportTableCommand`) and verified against known rows — full account, including a real usage mistake found and fixed live (a wrong `S3KeyPrefix` and a missing `InputCompressionType`), in [restore-drill.md § "D-22's export restore"](restore-drill.md).

## What is still needed — owner action

1. ~~Confirm the first scheduled run~~ — done, see above. The `rate(1 day)` schedule's own first *unattended* firing has not yet been separately observed, the same "manually verified, not yet seen fire on its own timer" gap `live-session-accessibility.md` named for its own cron trigger.
2. ~~Close TASK 5.4.1's own remaining gap~~ — done, see above and `restore-drill.md`.
3. ~~A CloudWatch alarm on export failure~~ — **built, 2026-08-29.** Two alarms, not one, both on `ndn-backup-export-alarm` (SNS, subscribed to `ALERT_EMAIL`) — a once-a-day function can fail in two ways one check would miss between them:
   - `ndn-backup-export-errors`: `BackupExportFunction`'s own `Errors` metric, `Period: 1 day`, `treatMissingData: notBreaching`. Catches the Lambda actually throwing (a bad env var, a revoked grant).
   - `ndn-backup-export-missed`: the same function's `Invocations` metric, `Period: 25 hours`, `LessThanThreshold: 1`, **`treatMissingData: breaching`** — deliberately the mirror image of the errors alarm. The more dangerous failure mode for a low-frequency scheduled job is exactly the silent one: the `EventBridge` rule disabled, deleted, or losing its target produces no error at all, since nothing was ever invoked to error. Zero invocations in 25 hours *is* the failure this alarm exists to catch, not an absence of information about one.

   **Named honestly, not covered by either alarm:** `ExportTableToPointInTime` only *starts* an async job (this file's own "What was built" section already says so) — a job that starts successfully and fails later, inside DynamoDB's own export process, produces no Lambda error and no missed invocation either. No CloudWatch metric this codebase found exposes that failure mode directly; catching it would need a follow-up invocation polling `dynamodb:DescribeExport`, more mechanism than this alarm pair's own small scope earned. A real, remaining gap, not silently claimed as covered.

   Live-diffed against production before merge: `cdk diff NdnDataStack` shows exactly 4 new resources (the topic, its email subscription, both alarms) — no change to `BackupExportFunction`, the bucket, or anything built by [#122](https://github.com/nourishthenerve/ndn-monolithic/pull/122). `data-stack.test.ts` (4 new tests): both alarms' exact metric/period/threshold/`treatMissingData` shape, and that neither exists in an ephemeral synth.

## Cost

Storage of a near-empty table's daily JSON export (a few KB/day at today's ~6-item table) plus one Lambda invocation/day, comfortably inside every existing free tier this account already relies on. Effectively £0.00 at current data volume — not separately broken out in `03-cost-model.md` for the same reason TASK 5.1.1's own one-off load-test cost wasn't: the amount is a rounding error against the account's own real month-to-date spend (`03-cost-model.md`'s own TASK 5.5.1 reconciliation, $0.49). Will need re-pricing once real patient/clinical data volume exists and the daily export is no longer near-empty — named here as a future reconciliation point, not silently assumed to stay free forever.
