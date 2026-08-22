# Runbook: production deploy GSI catch-up

**Status:** in progress, opened 2026-08-22 · **Found during:** Gate G3 review (production-health check) · **Severity:** blocks all future deploys to `main`; zero live user impact.

## What happened

`infra/src/data-stack.ts` defines four DynamoDB Global Secondary Indexes on `NdnDataStack`'s table — GSI2 (TASK 1.3.1), GSI1 (2.5.1), GSI3 (2.5.3), GSI4 (3.4.3) — each meant to land in its own deploy as the task that needed it merged. DynamoDB's `UpdateTable` API permits creating (or deleting) **at most one GSI per call**; CloudFormation does not serialize a multi-GSI diff into several calls for you, so a template that adds more than one new GSI since the last successful deploy fails outright.

At some point after GSI1 was added to the code (TASK 2.5.1), a production deploy silently stopped succeeding — GSI3 (2.5.3) and GSI4 (3.4.3) landed in code on top of it while the table itself was never confirmed to have actually picked up GSI1. By the time this was caught (Gate G3, 2026-08-22 ~21:00 UTC), production had fallen three GSIs behind: `aws dynamodb describe-table` against `ndn-prod` showed only **GSI2** `ACTIVE`, and every deploy attempt since 18:59 that day (three in a row, including the PR #87 merge) failed at the same step:

```text
NdnDataStack | UPDATE_FAILED | AWS::DynamoDB::Table | DataTable
Resource handler returned message: "Cannot perform more than one GSI creation or
deletion in a single update" (HandlerErrorCode: InvalidRequest)
```

Each failure rolled the stack back cleanly to `UPDATE_ROLLBACK_COMPLETE` (GSI2-only) — no data loss, no stuck stack. But every subsequent deploy — unrelated to these GSIs or not — hits the exact same wall, because the pending diff never shrinks on its own.

**Live user impact: none.** Every SSM parameter under `/ndn/` was empty at the time of discovery, so every feature flag reads default-off (fail-closed, TASK 1.6.2's design) — nothing that queries GSI1/GSI3/GSI4 is reachable by a real request regardless.

A related, secondary finding from the same review: GitHub branch protection with required status checks is not available on this repository's current plan (private repo, `gh api .../branches/main/protection` → 403, "Upgrade to GitHub Pro"). TASK 0.2.1's DoD ("cannot merge without green CI") is therefore not mechanically enforced — it's how a merge went through earlier the same day despite the `Deploy to production` job already being red. Out of scope for this runbook; noted for the Gate G3 report.

## Fix

Land the three missing GSIs (GSI1, GSI3, GSI4) one at a time, each its own PR merged to `main`, each its own real `Deploy to production` run — the same incremental shape the plan always intended, just executed for real this time instead of assumed. `infra/src/data-stack.test.ts`'s GSI-count assertion is adjusted alongside each step so the test suite always reflects what's actually being deployed, then restored to asserting all four once the incident is closed.

| Step | PR | Adds | Table state after |
|---|---|---|---|
| 1 | `fix/prod-deploy-gsi-catchup-1-of-3` | GSI1 | GSI1, GSI2 |
| 2 | `fix/prod-deploy-gsi-catchup-2-of-3` | GSI3 | GSI1, GSI2, GSI3 |
| 3 | `fix/prod-deploy-gsi-catchup-3-of-3` | GSI4 | GSI1, GSI2, GSI3, GSI4 (matches `main`'s intended state) |

No application code changes — `services/api`'s repositories already assume all four indexes exist; they were simply unable to reach GSI1/3/4 in production until each is actually deployed. GSI3/GSI4's `addGlobalSecondaryIndex` calls are temporarily commented out (not deleted) in step 1's and step 2's diffs, each restored in the next step, so the final state of `data-stack.ts` is byte-identical to how it read before this incident.

## Verification

After step 3 merges and deploys:

```bash
aws dynamodb describe-table --profile ndn-prod --region eu-west-2 \
  --table-name <DataTable physical id> \
  --query "Table.GlobalSecondaryIndexes[].{Name:IndexName,Status:IndexStatus}"
```

expected: all four (`GSI1`..`GSI4`) `ACTIVE`. `aws cloudformation describe-stacks --stack-name NdnDataStack` → `UPDATE_COMPLETE`. The next unrelated deploy to `main` succeeds without hitting the GSI-limit error.

## Resolution

**Step 1 deployed and verified, 2026-08-22 21:54 UTC.** PR #88 merged; `NdnDataStack` reached `UPDATE_COMPLETE`; `aws dynamodb describe-table` confirms GSI1 `ACTIVE` alongside GSI2. Step 2 (this PR) restores GSI3, GSI4 still withheld. Updated again once step 3 lands.

## Prevention

Not addressed by this runbook — worth raising at the Gate G3 review: a production deploy has no alerting on failure (CloudWatch/SNS or similar), so three consecutive silent failures over ~2.5 hours went unnoticed until this review's production-health check happened to look. TASK 0.5.x's cost alarms don't cover deploy failures; a "deploy job failed" notification is a gap the plan never named.
