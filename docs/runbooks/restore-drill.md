# Restore drill: a real DynamoDB PITR restore, executed (TASK 5.4.1)

**Date:** 2026-08-28, closed 2026-08-29 · **Task:** [05-execution-plan.md § TASK 5.4.1](../plan/05-execution-plan.md) · **Decisions:** [D-21](../plan/01-decisions.md), [D-22](../plan/01-decisions.md) · **Depends on:** 4.5.1

## Status: both halves executed and verified — TASK 5.4.1's own DoD met in full

This task's own DoD has two independent halves — "a real PITR restore **and** a real export restore have both been executed at least once." Both are now done, live, verified against known data, measured, and cleaned up.

**The export half could not be executed at the time this drill first ran, 2026-08-28: D-22's "periodic export to a separate object-locked prefix" had never been built.** No S3 bucket with Object Lock, no `AWS Backup` plan, no EventBridge export rule existed anywhere in `ndn-prod` — checked directly, not assumed from an absent grep hit alone. Built as its own task the same day — [backup-export.md](backup-export.md) — merged, deployed, and exercised for real the next day, 2026-08-29: §5 below.

## What was executed

### 1. Confirmed the real PITR window (not assumed)

```text
$ aws dynamodb describe-continuous-backups --table-name NdnDataStack-DataTable447BC44E-1PR4JFNRBCAB9
PointInTimeRecoveryStatus: ENABLED
RecoveryPeriodInDays: 35
EarliestRestorableDateTime: 2026-08-13T23:33:52+01:00
LatestRestorableDateTime:   2026-08-28T22:03:49+01:00
```

35 days, matching `03-cost-model.md`'s own assumption — checked live rather than trusted from the model.

### 2. Baseline: the live table, today

The live table holds 6 items, 1,560 bytes total (`describe-table`'s own `ItemCount`/`TableSizeBytes`, cross-checked against a `Select: COUNT` scan — no application in this codebase has gone live with real patient traffic yet; every item is a test/operational fixture, not clinical data):

| pk | sk |
|---|---|
| `CLI#a6423204-40a1-7090-e4b8-adff4a0724b1` | `META` |
| `CLI#a6423204-40a1-7090-e4b8-adff4a0724b1` | `PROFILE` |
| `CLI#PRINCIPAL_MARKER` | `MARKER` |
| `CLI#66f2a254-2061-70ee-7425-b6d435608c01` | `PROFILE` |
| `AUDIT#2026-08-28` | `2026-08-28T18:19:27.181Z#656bd25d-…` |
| `AUDIT#2026-08-27` | `2026-08-27T13:31:42.146Z#251521e6-…` |

The first four are the sub-clinician test identity (TASK 5.3.1) and the principal-clinician marker fixed by [#112](https://github.com/nourishthenerve/ndn-monolithic/pull/112); the two `AUDIT#` rows are the authorization decisions those same fixes produced. These six, by exact key, are this drill's "known real rows."

### 3. Restored — into a new, isolated table, never touching the live one

```text
$ aws dynamodb restore-table-to-point-in-time \
    --source-table-name NdnDataStack-DataTable447BC44E-1PR4JFNRBCAB9 \
    --target-table-name NdnRestoreDrill20260828 \
    --use-latest-restorable-time
```

Decision-to-restore: **2026-08-28T22:09:40+01:00**. Restored to point-in-time **2026-08-28T22:04:40+01:00** (the latest restorable moment at request time — DynamoDB PITR's own continuous-backup lag).

### 4. Verified — item count and every known row, by exact key

Table reached `ACTIVE` at **22:13:23+01:00** (3m43s after the restore call). Verification immediately followed:

- `Select: COUNT` scan: **6/6**, matching the live-table baseline exactly.
- All six known rows above: fetched by exact `pk`/`sk` `GetItem`, all six present.

**Verified-usable: 22:13:52+01:00.**

### 5. D-22's export restore — executed for real, 2026-08-29, one day after the pipeline deployed

`backup-export.md`'s own pipeline deployed via [#122](https://github.com/nourishthenerve/ndn-monolithic/pull/122), then triggered on demand (`aws lambda invoke` against `BackupExportFunction`, ahead of its own first scheduled tick) rather than waiting a full day for the `rate(1 day)` rule to fire. `dynamodb:ExportTableToPointInTime` completed in ~2 minutes: **6 items, 1,560 bytes — an exact match to §2's own live-table baseline**, written to `s3://ndn-prod-backup-exports-357601815388/exports/2026-08-29/AWSDynamoDB/01787990334662-cdf7a008/`.

**Object Lock confirmed on a real object, not just the bucket default**: `aws s3api get-object-retention` on the manifest returns `Mode: GOVERNANCE`, `RetainUntilDate: 2027-08-29` — exactly 365 days out, the mechanism working end to end for the first time.

**A real usage mistake, found and fixed live, not guessed.** The first `dynamodb import-table` attempt failed (`ItemValidationError`, all 8 objects under the prefix): `S3KeyPrefix` pointed at the export's whole folder, so `ImportTable` tried to parse the manifest JSON/MD5 files as item data too, and `InputCompressionType` was never set even though DynamoDB's own export writes gzip-compressed `.json.gz` files. `aws logs get-log-events` against the import's own `/aws-dynamodb/imports` error stream named the exact cause (`"Unexpected token"` / `"Expected 'Item' top level container"`) rather than being guessed at. Fixed by pointing `S3KeyPrefix` at the export's `data/` subfolder alone and adding `--input-compression-type GZIP`; the empty, failed table was deleted before retrying — never left as an orphan.

Retried into a new, isolated table (`NdnBackupImportDrill20260829`, the same "never touch the live table, never reuse a target" discipline §3 above already used): **`ImportedItemCount: 6`, `ErrorCount: 0`**. Verified the same way the PITR restore was — `Select: COUNT` scan (6/6) and `GetItem` on two of the same known rows (`CLI#a6423204.../META`, `CLI#PRINCIPAL_MARKER/MARKER`), both present by exact key. **Import-side RTO: 5 minutes 4 seconds**, decision-to-verified-usable (08:01:35 → 08:06:39 UTC, including the failed first attempt and its diagnosis).

**Cleanup, asymmetric on purpose.** The scratch import table was deleted immediately after verification, the same as every drilled table in this runbook. **The S3 export itself was not deleted, and was never going to be** — unlike the PITR restore's own disposable copy, this export is D-22's real, first, intended backup artifact, not test scaffolding; its whole purpose is to still exist in a year. It is also Object-Locked in GOVERNANCE mode specifically so that deleting it isn't a plain API call — doing so would mean invoking `ndn-break-glass`'s own MFA-gated procedure to grant a temporary `s3:BypassGovernanceRetention` policy, exactly the friction that mode exists to add, and not something to spend on a drill that has no reason to remove a real backup.

### 6. Torn down

```text
$ aws dynamodb delete-table --table-name NdnRestoreDrill20260828
TableStatus: DELETING
```

Confirmed fully gone via `describe-table` returning `ResourceNotFoundException` at **22:14:20+01:00**. `aws dynamodb list-tables` afterward shows only the live table. No scratch export copy existed to clean up (§5).

## Measured RTO

**PITR half — decision to verified-usable: 4 minutes 12 seconds** (2026-08-28, 22:09:40 → 22:13:52+01:00), against D-21's ≤4-**working-hours** target. `RESTORE_IN_PROGRESS → ACTIVE` alone took 3m43s of that; verification (a COUNT scan plus six `GetItem` calls) added 29s.

**Export/import half — decision to verified-usable: 5 minutes 4 seconds** (2026-08-29, 08:01:35 → 08:06:39 UTC), including the failed first import attempt, its diagnosis via CloudWatch, and a corrected retry — the real number a real operator following this exact runbook would hit, not an idealised one.

Both are measured facts now, not a belief resting on "PITR is enabled" or "the export pipeline exists." **Neither number is the number a real incident would produce.** The live table holds 6 items today; both PITR's own restore duration and DynamoDB's own export/import duration scale with table size, not a fixed constant, and a real incident adds decision-making and communication time this drill's own single-operator, pre-planned runs don't include. What these numbers *do* establish: both **mechanisms** — API call, wait, verify, tear down — work, are fast at today's data volume, and leave the live table untouched throughout. Re-run this drill periodically as real data volume grows, per `05-execution-plan.md`'s own "a backup nobody has restored from is a belief, not a fact" reasoning — the same belief now applies to "restore/import time scales acceptably," unproven at real volume.

## Cost

Transient, sub-cent for both halves: each scratch table's own `PAY_PER_REQUEST` billing for a few minutes of existence (6 items, a handful of reads), then deleted — no recurring line, `03-cost-model.md` needs no change. The one non-transient artefact is the real S3 export itself (§5), already priced in `backup-export.md`'s own Cost section as part of the pipeline's ordinary operation, not this drill's.

## Do NOT

Restore or import into or over the live table (this drill never did either — a new, uniquely-named target every time, for both the PITR restore and the export import). Leave a drill's scratch table running after verification (both existed only a few minutes, start to delete). Delete the real S3 export itself to "clean up" — it isn't drill scaffolding, it's D-22's own first real backup, and its Object Lock is what stops exactly that kind of casual deletion.
