# Log retention and volume control (TASK 0.5.2)

**Date:** 2026-08-10 · **Task:** [05-execution-plan.md § TASK 0.5.2](../plan/05-execution-plan.md) · **Requirements:** FR-X-05 · **Risks:** [R-11](../plan/02-risk-register.md) · **Depends on:** 0.4.1

## What this covers

R-11's four named mitigations — "14-day retention, sampled request logs, no debug logging in prod, log-volume alarm" — landed before Phase 1 adds any route that could actually generate meaningful log volume. CloudWatch Logs bills ingestion at $0.5985/GB with no default cap on retention (a log group left alone stores forever), so this closes the gap between "logging exists" and "logging is unbounded."

## What was built

- **`infra/src/log-retention.ts`** —
  - `LOG_RETENTION` = `RetentionDays.TWO_WEEKS`, the single source of truth for the 14-day figure D-18 already committed to.
  - `createLogGroup(scope, id, logGroupName)` — the way every Lambda in this repo should get its log group from now on: an explicit `LogGroup` construct passed via the modern `logGroup` prop (the deprecated `logRetention` prop this replaces cannot set retention on Lambda's own auto-created group). `RemovalPolicy.DESTROY` — logs are operational exhaust, not the "patient, clinical, content or media data" `00-conventions.md`'s delete prohibition protects, same reasoning `web-stack.ts`'s `BucketDeployment` pruning already uses.
  - `enforceLogRetention(scope)` — an `Aspect` applied once, app-wide, in `bin/app.ts`. It visits every `CfnLogGroup` in the synthesized tree and sets `retentionInDays` to 14 **only if nothing set it already**, so a future log group that forgets to call `createLogGroup` still gets capped rather than silently reverting to infinite retention — belt-and-braces alongside the explicit call, matching `09-self-audit.md`'s "CDK default rather than a habit."
- **`infra/src/web-stack.ts`** — the health Lambda now gets an explicit `logGroup: createLogGroup(this, 'HealthFunctionLogGroup', '/ndn/health-function')` instead of Lambda's implicit (infinite-retention) default.
- **`services/api/src/logger.ts`** — `createSampledLogger`, implementing `00-conventions.md`'s logging rule verbatim: structured JSON, one line per request, sampled, `level: 'info'` always (no debug level exists to accidentally ship). Sample rate and randomness are both injectable, alongside the existing `Clock` pattern — deterministic in tests, matching "time is injectable" already established by `clock.ts`. Default sink is `process.stdout`, which is what Lambda's log capture reads; nothing calls `console.log` directly.
- **`services/api/src/health.ts`** — wired to `createSampledLogger` at a 10% sample rate (`HEALTH_LOG_SAMPLE_RATE`). `/health` is the one route hit continuously today (UptimeRobot, D-18) and would otherwise be the largest single source of log volume in Phase 0 — 10% keeps a visible trail without paying to store the other 90%. The handler now also carries the API Gateway `requestId` through to the log line, and returns the same response as before (`health.test.ts` still asserts the exact body shape).
- **`infra/src/budget-stack.ts`** — a fourth alarm alongside the three from TASK 0.5.1, since CloudWatch Alarms (unlike `AWS::Budgets::Budget` and `AWS::CE::Anomaly*`) have no built-in email subscriber and need an SNS topic:
  - `LogIngestionAlarmTopic` (SNS) with an `EmailSubscription` to `ALERT_EMAIL` — same address every other alert in this account already goes to.
  - `LogIngestionVolumeAlarm`: a `MathExpression` using a `SEARCH` expression — `SEARCH('{AWS/Logs,LogGroupName} MetricName="IncomingBytes"', 'Sum', 86400)` — summing `IncomingBytes` across **every** log group in the account, not one named group. New log groups automatically fall inside the search without touching this file again, the same "no manual maintenance as new things enter the bill" reasoning `03-cost-model.md`/`budget-stack.ts` already applies to the SERVICE-dimensioned cost-anomaly monitor.

    > **Superseded 2026-08-13.** AWS's `PutMetricAlarm` API rejects any alarm math expression containing `SEARCH()` — this design was never actually deployable, and silently broke every production deploy from this task onward (0.5.2, 0.5.3, 0.6.1 all failed at this exact resource). Fixed in TASK 0.6.2 with an explicit, named per-log-group metric list (`MONITORED_LOG_GROUP_NAMES`, `infra/src/config.ts`) summed via `FILL(...) + FILL(...)`. See [rollback.md](rollback.md#a-pre-existing-bug-this-task-found-and-had-to-fix-first) for the full root-cause and fix writeup — the "Verification" and "Live-account diff" sections below describe the design as it was believed to work at the time, not its current, corrected shape.
  - Threshold: `LOG_INGESTION_ALARM_THRESHOLD_BYTES` = 350,000,000 bytes/day, in `infra/src/config.ts`. `03-cost-model.md` models a baseline of ~2GB/month (~67MB/day); the alarm trips at ~5× that — a month sustained at 350MB/day would cost ~$6.28 (350MB × 30 ÷ 1e9GB × $0.5985/GB), already a meaningful slice of the $24.21 budget (TASK 0.5.1) without tripping on ordinary day-to-day variance.
  - `TreatMissingData.NOT_BREACHING` — a quiet day with nothing logged is not an incident.

## Verification

CDK-synth tests (`infra/src/log-retention.test.ts`, `web-stack.test.ts`, `budget-stack.test.ts`) prove, with zero live AWS calls:

- `createLogGroup` produces `RetentionInDays: 14` and a `Delete` removal policy.
- `enforceLogRetention` caps a `CfnLogGroup` that set no retention of its own, and leaves alone one that already set a finite retention explicitly (30 days, in the test) — the aspect only fills a gap, it never overrides an explicit choice.
- The health Lambda's `LoggingConfig.LogGroup` points at the explicit, 14-day-retention log group, not Lambda's implicit default.
- `LogIngestionVolumeAlarm` exists with the right `SEARCH` expression, threshold, comparison operator, and `notBreaching` missing-data treatment; `AlarmActions` references the SNS topic; the topic has an `email` subscription to `ALERT_EMAIL`.

`services/api/src/logger.test.ts` and the updated `health.test.ts` prove the sampling logic itself (deterministic via an injected `random`) and that the health handler logs exactly one line per request, carrying `requestId`/`route`/`statusCode`/`durationMs`.

`pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green, 0 failures (infra: 37 tests, services/api: 36 tests).

### Live-account diff (read-only, no deploy)

Neither change adds a new stack — both `NdnWebStack` and `NdnBudgetStack` already exist in `ndn-prod` (`357601815388`) from TASK 0.4.1 and 0.5.1. Unlike those two tasks, this one doesn't need a manual first deploy: the existing `deploy` job in `.github/workflows/ci.yml` (assumes `ndn-deploy` via OIDC on merge to `main`) picks these changes up the same way it picks up any other incremental change. `cdk diff` against the live stacks (admin profile, read-only — no state mutated) confirms the change is purely additive with no resource replacement:

```text
$ AWS_PROFILE=ndn-prod npx cdk diff NdnWebStack NdnBudgetStack
Stack NdnWebStack
[+] AWS::Logs::LogGroup HealthFunctionLogGroup HealthFunctionLogGroup436AF81E
[~] AWS::Lambda::Function HealthFunction HealthFunction19D7724A
 ├─ [~] Code            (ordinary — every deploy repackages the handler)
 ├─ [~] Environment      (ordinary — DEPLOY_VERSION tracks GITHUB_SHA)
 └─ [+] LoggingConfig    (new — the explicit log group)

Stack NdnBudgetStack
[+] AWS::SNS::Topic LogIngestionAlarmTopic
[+] AWS::SNS::Subscription LogIngestionAlarmTopic/mohammed.zia33+ndnprod@gmail.com
[+] AWS::CloudWatch::Alarm LogIngestionVolumeAlarm
[+] Output LogIngestionAlarmName
```

No `[-]` (removal) or replacement anywhere. The health Lambda keeps its identity; it only gains a `LoggingConfig` pointing at the new, retention-capped log group. Its previous auto-created `/aws/lambda/HealthFunction...` group (infinite retention, effectively empty — the function has only ever served synthetic health checks) is simply no longer written to; it is not deleted, and will itself age out under the 14-day retention `enforceLogRetention`'s safety net would apply to it too if it were a CDK-managed resource — it isn't, so it's just abandoned, not a `DeleteObject`/`DeleteItem`-style removal `00-conventions.md` would prohibit.

Cost Anomaly Detection has no equivalent forced-test path for this alarm either (same limitation `budgets-cost-alarms.md` already documents) — CloudWatch Alarms *do* support a forced state transition (`aws cloudwatch set-alarm-state`), but that only proves the alarm→SNS→email wiring, not that AWS actually evaluates the `SEARCH` expression correctly; the synth tests above are the stronger proof for a metric-math alarm with nothing to measure yet (this account logs well under a megabyte a day today).

## Cost

~£1.00/mo, matching the execution plan's estimate: the log group's own storage/ingestion (already priced into `03-cost-model.md`'s ~$1.23/mo CloudWatch Logs line) plus the new alarm (CloudWatch Alarms: first 10 free) and SNS topic (email delivery: 1,000 free/month, this account sends at most a handful).

## Follow-up, 2026-08-21 — the implicit-log-group leak (Gate G1 §4)

**The finding, in one line:** this task's DoD is "no log group has infinite retention", and from the day it landed it was false — not for the groups it created, but for the ones nobody created.

Raised at Gate G0 (§4, 2 orphaned groups), left unactioned, re-raised at Gate G1 (§4, 10 orphans plus the live stack's own 2) as the only engineering action item of that review still open. It was 13 by the time this fix was written — one more had appeared from PR #47 in the four days between the review and the fix, which is the point: the count grows with every PR that deploys.

### Root cause

`enforceLogRetention`'s Aspect can only reach a `CfnLogGroup` — a log group that is a *resource in the template*. A Lambda with no `logGroup` prop has none: the CloudWatch Logs service creates `/aws/lambda/<function-name>` on the function's first write, outside CloudFormation, with retention "never expire" and no removal policy for `cdk destroy` to act on. The aspect never sees it, because from CloudFormation's point of view it does not exist.

Exactly one function in the app was in that position — and not one of ours. `BucketDeployment` (`web-stack.ts`, the construct that uploads `apps/web/dist`) brings its own singleton Lambda, `Custom::CDKBucketDeployment`. Every one of the 13 orphans is that function's group, one per stack that ever deployed:

```text
/aws/lambda/NdnWebStack-CustomCDKBucketDeployment...      42,576 bytes, Retention: None
/aws/lambda/NdnWebStackPr23-CustomCDKBucketDeployment...   4,401 bytes, Retention: None
...Pr25, Pr26 (x2), Pr27 (x2), Pr28, Pr29, Pr30, Pr47, Pr999
/aws/lambda/NdnWebStack-HealthFunction19D7724A-...           740 bytes, Retention: None
```

The last one is different and already inert: the health Lambda's pre-0.5.2 group, abandoned (not deleted) when this task gave it an explicit one — the "simply no longer written to" case the Live-account diff section above describes.

### What was fixed

- **`web-stack.ts`, production** — `BucketDeployment` now takes `logGroup: createLogGroup(this, 'SiteDeploymentLogGroup', '/ndn/site-deployment')`. Same treatment every other Lambda in the repo already had, through the same helper: 14-day retention, `RemovalPolicy.DESTROY`, a resource CloudFormation owns.
- **`web-stack.ts`, ephemeral** — the opposite, and the reason is in the next section: an ephemeral stack creates no group of its own and **imports** the shared `/ndn/pr-env/site-deployment` (`PR_ENV_SITE_DEPLOYMENT_LOG_GROUP_NAME`, `config.ts`) instead. Nothing per-PR is created, so nothing per-PR is left behind.
- **`log-retention.ts`** — a second Aspect, `ExplicitLambdaLogGroupAspect`, applied by the same `enforceLogRetention(app)` call in `bin/app.ts`. It visits every `CfnFunction` and raises a synth-time **error** on any that has no `LoggingConfig.LogGroup`. This is the part that stops the finding recurring: a future Lambda — ours, or one a construct creates on our behalf — cannot reach production relying on CloudWatch's implicit group, because `cdk synth` refuses to produce a template at all. Verified against the CLI, not just asserted in a test: a deliberately log-group-less function makes `cdk synth` print `Synthesis finished with errors` and exit 1, which fails CI's `deploy` job.

  The check reads the L1 property rather than the synthesized JSON, so a `LoggingConfig` injected via `addPropertyOverride` would read as absent. That is deliberate: the guard's job is to insist on the supported prop, and a silent pass is the failure mode it exists to prevent.

  **If a future construct gives you no way to name its function's log group** — some CDK-owned helper Lambdas don't expose the prop — the fallback is not to weaken the aspect. Give that function an explicit `functionName` and construct its log group yourself under the name CloudWatch would have used:

  ```ts
  createLogGroup(this, 'SomeFunctionLogGroup', `/aws/lambda/${functionName}`);
  ```

  CloudWatch writes to the group of that exact name, and because CloudFormation now owns it, retention and `DESTROY` apply as normal. That keeps the invariant ("every log group in this account is a stack resource with 14-day retention") rather than carving an exception into it.

- **`config.ts` — alarm coverage, while here.** The log-volume alarm summed 7 named groups; 12 existed. The two public GET endpoints (`content-read`, `workshop-read`) were among the missing five, and they are the highest-volume groups in the estate the moment their flags come on — every blog and workshops page view hits one. They are now in the list, with `media-upload` (largest per-request payloads) taking the last free slot.

  **The list stops at 10 because AWS stops it at 10.** `PutMetricAlarm` answers an eleventh metric with `ValidationError: Too many metrics in alarm, maximum is 10` — probed against the real API in `eu-west-2` on 2026-08-21 (10 metrics + the sum expression: accepted; 13 + the expression: rejected; probe alarm deleted afterwards), the same way the `SEARCH()` rejection was found and for the same reason: CDK synth accepts either happily. The three groups that do not fit — `content-authoring`, `workshop-authoring`, `site-deployment` — are now named in `UNMONITORED_LOG_GROUP_NAMES` rather than merely absent, and they are the three lowest-volume groups in the estate (a few KB per deploy or per publish). Their bytes still expire on the same 14-day retention; they are simply not summed into the alarm, which under-reports total ingestion by a rounding error rather than missing a plausible runaway.

### Verification

Synth-only, no live AWS calls, in `log-retention.test.ts` and `web-stack.test.ts` (infra: 119 tests, 0 failures):

- The aspect raises its error on a Lambda with no explicit log group, and stays silent on one that has it. Proved capable of failing: with the aspect removed, that test fails and the other nine still pass.
- Every Lambda in both production stacks — 13 functions, `Custom::CDKBucketDeployment` included — has `LoggingConfig.LogGroup` set. Asserted for the ephemeral shape too, where all three of its log group names carry the PR label.
- `/ndn/site-deployment` synthesizes with `RetentionInDays: 14` and `DeletionPolicy: Delete`.
- `MONITORED_LOG_GROUP_NAMES.length <= 10` (the API ceiling), and the monitored + unmonitored lists together account for **every** `/ndn/*` log group the app synthesizes — so a new `createLogGroup()` call fails the build until someone decides which list it belongs in, instead of quietly going unmonitored the way five groups did.

**A CI timeout this exposed, and the fix for it.** The first CI run of this change failed: `quality` (`timeout-minutes: 15`) was killed at 15m13s, with every test passing. The infra suite alone took **369 seconds** on the runner, and `test:coverage` re-runs the whole thing a second time in the same job. The cause is not new — `web-stack.test.ts` and `data-stack.test.ts` call `synth()` once per assertion (~93 times between them), and every call rebuilds the CDK app and re-bundles all thirteen Lambdas through esbuild. The four synth-heavy tests added here were simply what pushed a suite that was already near the ceiling over it.

Both files (and this one) now synthesize each distinct stack shape **once** and share the `Template`, which the assertions library only ever reads. Infra: **369s → 15s locally, 119 tests, same assertions**. No test was weakened or removed to get there; the negative check still holds — remove `ExplicitLambdaLogGroupAspect` and exactly one test fails.

### Live-account diff (read-only, no deploy)

```text
$ AWS_PROFILE=ndn-prod npx cdk diff NdnWebStack NdnBudgetStack
Stack NdnWebStack
[+] AWS::Logs::LogGroup SiteDeploymentLogGroup SiteDeploymentLogGroup07FC5F1F
[~] AWS::Lambda::Function Custom::CDKBucketDeployment...
 └─ [+] LoggingConfig                       (new — the explicit log group)
[~] AWS::Lambda::Function HealthFunction    (ordinary — DEPLOY_VERSION, local synth has no GITHUB_SHA)

Stack NdnBudgetStack
[~] AWS::CloudWatch::Alarm LogIngestionVolumeAlarm
 └─ [~] Metrics                             (m7, m8, m9 — the three added groups)
```

`NdnDataStack`: no differences. No `[-]` and no replacement anywhere except the Lambda version churn that every deploy produces.

### Account-side remediation, applied 2026-08-21

The 13 existing groups predate the fix and are not CloudFormation-managed, so no deploy can reach them. All 13 were given the same 14-day policy by hand:

```text
$ for g in $(aws logs describe-log-groups --query 'logGroups[?retentionInDays==null].logGroupName' --output text); do
    aws logs put-retention-policy --log-group-name "$g" --retention-in-days 14
  done
$ aws logs describe-log-groups --query 'logGroups[?retentionInDays==null].logGroupName' --output text
(empty)
```

**Zero log groups in the account now have infinite retention** — this task's DoD, true on the live account for the first time.

Retention expires log *events*, not the group, so the 12 orphaned shells (11 from destroyed PR stacks, 1 from the pre-0.5.2 health function) will empty themselves within a day and then sit at 0 bytes, costing nothing. They are left in place rather than deleted: `put-retention-policy` is the sanctioned mechanism D-18 already decided on, and it makes deletion unnecessary rather than merely deferred. Removing the empty shells is a two-minute console tidy-up whenever anyone wants it, with nothing depending on it.

### The first live run found a second race — and it is why ephemeral stacks import

The fix above was verified the only way that counts: PR #48's own `pr-environment` job deployed a real ephemeral stack and destroyed it. Two things came back.

**The good half.** No `/aws/lambda/NdnWebStackPr48-CustomCDKBucketDeployment...` group was created. That is the first PR in this project's history not to add one, and the leak this task set out to close is closed.

**The half that was not anticipated.** The stack-owned `/ndn/pr-48/site-deployment` group **survived `cdk destroy`, with no retention** — a differently-named orphan of exactly the same shape. The evidence is unambiguous:

```text
log stream events (first/last):  1787326633415 / 1787326633481
log group creationTime:          1787326642465   <- 9 seconds LATER
```

A group cannot be created after the events it holds unless it was created twice. What happens is a race that only a *destroyed* stack can lose: `cdk destroy` deletes the log group, and the same teardown invokes `Custom::CDKBucketDeployment` with a `Delete` event. That Lambda logs, its output flushes asynchronously a moment later, and CloudWatch — finding no group of that name — recreates it. The recreated group is not a CloudFormation resource, so it has no retention, no removal policy, and nothing to delete it. This is why `RemovalPolicy.DESTROY` on the log group of a Lambda that its own teardown invokes cannot be made to work by tightening it.

Three alternatives were considered and rejected before the one that shipped:

- **`RemovalPolicy.RETAIN` on the per-PR group.** Removes the race, but `AWS::Logs::LogGroup` fails to create when the name already exists, so re-running the same PR's job would fail the deploy — the identical "already exists" trap PR #47 hit with the SES pipeline ([ephemeral-pr-environments.md](ephemeral-pr-environments.md)).
- **A post-`destroy` sweep in CI** (`put-retention-policy`, or deleting the group). Needs IAM `ndn-deploy-pr` does not have, and the delete variant would hand a PR-triggered role a destructive permission this repo deliberately withholds.
- **Reverting to no explicit group for that one Lambda.** That is the original bug.

**What shipped instead: ephemeral stacks import a group nothing owns.** `/ndn/pr-env/site-deployment` is created out of band with 14-day retention, shared by every PR stack, and referenced by name (`LogGroup.fromLogGroupName`). No stack creates it, so there is no "already exists"; no stack deletes it, so there is no race; and the count of log groups in the account no longer grows with PR volume at all — a better outcome than the per-PR group this task originally aimed for. Log streams stay distinguishable because CloudWatch names each one after the writing function instance (`NdnWebStackPr48-CustomCDKBucketDeployment...`).

Created once, and recorded here because it is the one log group in the estate CloudFormation does not manage:

```text
aws logs create-log-group     --log-group-name /ndn/pr-env/site-deployment
aws logs put-retention-policy --log-group-name /ndn/pr-env/site-deployment --retention-in-days 14
```

**Its honest weakness:** being owned by no stack, its retention is not enforced by `enforceLogRetention` or by any test — the aspect only reaches template resources. It is one hand-made group, in the same category as the ACM certificate and the SSM parameters this repo already creates out of band, and the same standing check covers it: `describe-log-groups --query 'logGroups[?retentionInDays==null]'` returning empty. Making CI assert that on every run needs the same IAM decision as the standing-cost check ([ephemeral-pr-environments.md](ephemeral-pr-environments.md)).

### What this does not cover

Any PR stack still deploying from a branch cut before this change will leave one more `/aws/lambda/NdnWebStackPrNN-CustomCDKBucketDeployment...` orphan behind, with no retention, until that branch merges or rebases. The count should stop at 13 and go no higher once `main` carries this; if a 14th appears, that is what it means. (`/ndn/pr-48/site-deployment`, the one the race created, was capped at 14 days by hand along with the other 13.)
