# Budgets and cost alarms (TASK 0.5.1)

**Date:** 2026-08-10 · **Task:** [05-execution-plan.md § TASK 0.5.1](../plan/05-execution-plan.md) · **Requirements:** C-01, NFR-02 · **Depends on:** 0.4.1

## What this covers

The account-wide cost guard that must exist before Phase 1 adds anything that could grow spend unnoticed (`docs/plan/09-self-audit.md`, item 5): a second CDK stack, `infra/src/budget-stack.ts` (`NdnBudgetStack`), holding an AWS Budgets threshold budget and AWS Cost Anomaly Detection, both emailing `mohammed.zia33+ndnprod@gmail.com` (the account's own root-user contact address, `docs/runbooks/aws-account-baseline.md`) — plus a cost-allocation tag (`Project=nourishthenerve`) applied app-wide via `Tags.of(app)` in `infra/bin/app.ts`.

## Why a separate stack, same region

Both `AWS::Budgets::Budget` and `AWS::CE::Anomaly*` are account-global services with no per-region console, but empirically (`aws budgets describe-budgets` / `aws ce get-anomaly-monitors` return identical results regardless of `--region`) they don't require a `us-east-1` stack the way ACM-for-CloudFront does. `NdnBudgetStack` deploys to `eu-west-2`, same as `NdnWebStack` — no new region bootstrap needed.

## Why the budget is denominated in USD, not GBP

C-01's cap is stated in £20/month, but `aws ce get-cost-and-usage` confirms this account is billed in USD (`"Unit": "USD"`). `MONTHLY_BUDGET_LIMIT_USD` in `infra/src/config.ts` converts at the same planning rate `docs/plan/00-index.md` and `03-cost-model.md` use throughout — £1 = $1.2105 (the ECB rate less C-01's required 10% adverse buffer) — giving **$24.21**.

## What was built

- **`infra/src/config.ts`** — `ALERT_EMAIL`, `MONTHLY_BUDGET_LIMIT_USD` ($24.21), `COST_ALLOCATION_TAG_KEY`/`_VALUE` (`Project`/`nourishthenerve`).
- **`infra/src/budget-stack.ts`** (`BudgetStack`) —
  - `AWS::Budgets::Budget` `ndn-monthly-cost-cap`: `COST`/`MONTHLY`, limit $24.21, three `NotificationsWithSubscribers` (ACTUAL spend, `GREATER_THAN`, `PERCENTAGE` thresholds 50/75/90), each with a single `EMAIL` subscriber. A block never happens in code (unlike 0.5.3's SMS cap) — there's no code-level enforcement point for AWS bill growth, so this is a warning ladder, not a hard stop.
  - `AWS::CE::AnomalyMonitor` `ndn-cost-anomaly-monitor`: `DIMENSIONAL`/`SERVICE` — AWS-managed, tracks per-service spend patterns account-wide with no manual maintenance as new services enter the bill.
  - `AWS::CE::AnomalySubscription` `ndn-cost-anomaly-subscription`: `DAILY` frequency (required for `EMAIL` delivery — `IMMEDIATE` is SNS-only), linked to the monitor, `$5` absolute-impact threshold (a meaningful fraction of this account's ~$3–10/mo total spend per `03-cost-model.md`).
  - All three carry `ResourceTags: [{ Key: 'Project', Value: 'nourishthenerve' }]` explicitly — `AWS::Budgets::Budget` has no `TagManager` at all, and the CE resources' `ITaggableV2` support wasn't relied on for consistency across all three.
- **`infra/bin/app.ts`** — `Tags.of(app).add('Project', 'nourishthenerve')` before any stack is constructed, so every ordinary taggable resource in both stacks (the site bucket, the health Lambda, the HTTP API, the CloudFront distribution, …) gets it via CDK's standard tagging aspect.

## Verification (real AWS, 2026-08-10)

Deployed directly (admin profile, `ndn-deploy`'s CI role gets it automatically on the next merge to `main` — same one-time-first-deploy pattern as TASK 0.4.1):

```text
$ AWS_PROFILE=ndn-prod npx cdk deploy NdnBudgetStack --require-approval never
...
NdnBudgetStack.AnomalyMonitorArn = arn:aws:ce::357601815388:anomalymonitor/e6fa2ff6-de3d-4d0f-98d7-390eb4b606bb
NdnBudgetStack.BudgetName = ndn-monthly-cost-cap
```

Live config confirmed via the real APIs — `describe-budgets`, `describe-notifications-for-budget`, `describe-subscribers-for-notification`, `get-anomaly-monitors`, `get-anomaly-subscriptions` — matches what was synthesized: $24.21 limit, three notifications at 50/75/90% each with the right email subscriber, one `DIMENSIONAL`/`SERVICE` monitor, one `DAILY` subscription at the monitor with a $5 threshold and a `CONFIRMED` email subscriber (Cost Anomaly Detection's own subscriber flow auto-confirms — no separate SNS-style confirmation click needed).

### The alert genuinely fires — forced-breach test

`describe-notifications-for-budget`'s `NotificationState` field on the real budget is a *live evaluated* value, not static config (`OK` while under threshold). To prove AWS actually flips it to `ALARM` rather than just accepting the config, a disposable scratch budget (`ndn-scratch-alert-forcing-test`, **not** part of the committed IaC — created directly via `aws budgets create-budget`, deleted immediately after) was given a $0.001 limit at a 100% `ACTUAL`/`GREATER_THAN` threshold — already below this account's real month-to-date spend (~$0.006):

```text
$ aws budgets describe-notifications-for-budget --budget-name ndn-scratch-alert-forcing-test ...
{
    "Notifications": [
        {
            "NotificationType": "ACTUAL",
            "ComparisonOperator": "GREATER_THAN",
            "Threshold": 100.0,
            "NotificationState": "ALARM"
        }
    ]
}
```

`ALARM` within seconds of creation — AWS evaluates a new budget against already-known spend essentially immediately, it does not wait for a multi-hour refresh cycle. The scratch budget was deleted immediately after (`aws budgets delete-budget`) — this is a throwaway AWS Budgets test artifact, not a protected data store, so it's outside `00-conventions.md`'s delete prohibition (which covers `DeleteItem`/`DeleteObject`/`TRUNCATE`/`DROP` against clinical/personal data, not disposable infra test fixtures).

Cost Anomaly Detection has no equivalent forced-test path (no manually-triggerable "create an anomaly" API) — its wiring is proven by the CDK synth tests and the live `get-anomaly-subscriptions` config check above.

## Cost allocation tags: activation is a manual, cross-account step

`Project=nourishthenerve` is applied to every taggable resource — proven at synth time by `infra/src/tagging.test.ts`, and confirmed against the real account for `NdnBudgetStack`'s own three resources (`ResourceTags` in the `describe-budgets`/`get-anomaly-monitors`/`get-anomaly-subscriptions` output above). `NdnWebStack`'s resources pick up the tag too (`cdk diff NdnWebStack` shows only additive `Tags` changes, no replacements) but weren't redeployed here — that stack's `DEPLOY_VERSION` is wired to `GITHUB_SHA`, so a local admin-profile deploy would have overwritten the live `/health` version with `'local'`; it picks up the tag on the next ordinary CI deploy to `main` instead. A tag only becomes a **cost allocation tag** — usable to filter/break down Cost Explorer and future budgets by it — once activated. `aws ce list-cost-allocation-tags` against `ndn-prod` (`357601815388`) fails with `AccessDeniedException: Linked account doesn't have access to cost allocation tags` — this is an **Organization management-account-only** action (`ndn-prod` is a member account under the existing payer, D-01), same cross-account boundary `docs/runbooks/iac-baseline.md` hit for DNS. Unlike that DNS record, this reaches into `803129122420` — the account this repo's memory flags as shared with an unrelated project (islamicmaps) — so it wasn't done unilaterally here.

**Manual step (you):** from the management account, once AWS's billing pipeline has seen at least one bill with the `Project` tag (usually within 24h): Billing console → *Cost allocation tags* → activate `Project`, or `aws ce update-cost-allocation-tags-status --cost-allocation-tags-status Key=Project,Status=Active` with management-account credentials.

## Cost

$0 — both AWS Budgets (≤2 budgets free) and Cost Anomaly Detection (free regardless of monitor/subscription count) stay within always-free allowances. Matches the execution plan's `Cost: £0.00`.
