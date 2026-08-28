# Restore drill: a real DynamoDB PITR restore, executed (TASK 5.4.1)

**Date:** 2026-08-28 · **Task:** [05-execution-plan.md § TASK 5.4.1](../plan/05-execution-plan.md) · **Decisions:** [D-21](../plan/01-decisions.md), [D-22](../plan/01-decisions.md) · **Depends on:** 4.5.1

## Status: PITR half executed and verified; D-22's export half now built, restore-side check still open

This task's own DoD has two independent halves — "a real PITR restore **and** a real export restore have both been executed at least once." The PITR half is done, live, verified against known data, measured, and cleaned up (below).

**The export half could not be executed at the time this drill first ran: D-22's "periodic export to a separate object-locked prefix" had never been built.** No S3 bucket with Object Lock, no `AWS Backup` plan, no EventBridge export rule existed anywhere in `ndn-prod` — checked directly (`aws s3api list-buckets`, `aws backup list-backup-plans`, `aws events list-rules`), not assumed from an absent grep hit alone. `05-execution-plan.md`'s own task text treats this as something to *restore from*, at M5.4, written as though an earlier task built it; tracing every task from Phase 0 through the DataStack build (TASK 1.3.1, which added PITR itself) found no task that ever did.

**Built as its own task, 2026-08-28 — see [backup-export.md](backup-export.md).** The pipeline (a daily, GOVERNANCE-mode Object-Locked export) is live-diffed against production and pending deploy on merge. What's still open is the *restore*-side half of this drill: once a real export has actually run at least once, come back here and import it into a scratch table (`ImportTableCommand`), verify against known rows, the same discipline §3 below already used for the PITR half — `backup-export.md`'s own "What is still needed" section names this as its item 2, not duplicated here.

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

### 5. D-22's export restore — not performed in this run (see Status above); the export pipeline itself now exists ([backup-export.md](backup-export.md))

### 6. Torn down

```text
$ aws dynamodb delete-table --table-name NdnRestoreDrill20260828
TableStatus: DELETING
```

Confirmed fully gone via `describe-table` returning `ResourceNotFoundException` at **22:14:20+01:00**. `aws dynamodb list-tables` afterward shows only the live table. No scratch export copy existed to clean up (§5).

## Measured RTO

**Decision to verified-usable: 4 minutes 12 seconds** (22:09:40 → 22:13:52+01:00), against D-21's ≤4-**working-hours** target — a measured fact now, not a belief resting on "PITR is enabled." `RESTORE_IN_PROGRESS → ACTIVE` alone took 3m43s of that; verification (a COUNT scan plus six `GetItem` calls) added 29s.

**This number is not the number a real incident would produce.** The live table holds 6 items today; a restore's wall-clock time on a multi-gigabyte table with real patient/appointment/clinical-record volume will be materially longer (DynamoDB's own PITR restore duration scales with table size, not a fixed constant), and a real incident adds decision-making and communication time this drill's own single-operator, pre-planned run does not include. What this number *does* establish: the **mechanism** — API call, wait, verify, tear down — works, is fast at today's data volume, and leaves the live table untouched throughout. Re-run this drill periodically as real data volume grows, per `05-execution-plan.md`'s own "a backup nobody has restored from is a belief, not a fact" reasoning — the same belief now applies to "restore time scales acceptably," unproven at real volume.

## Cost

Transient, sub-cent: the restored table's own `PAY_PER_REQUEST` billing for ~5 minutes of existence, 6 items, one `Select: COUNT` scan and six `GetItem` calls, then deleted. No recurring line — `03-cost-model.md` needs no change.

## Do NOT

Restore into or over the live table (this drill never did — a new, uniquely-named target every time). Leave a drill's restored table running after verification (this one existed 5 minutes, start to delete). Treat this runbook as closing D-22 on its own — the export pipeline is built ([backup-export.md](backup-export.md)), but the restore-side check (item 2 there) is still open.
