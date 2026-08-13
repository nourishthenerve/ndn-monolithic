# Canary deploy, smoke test, auto-rollback (TASK 0.6.2)

**Date:** 2026-08-13 · **Task:** [05-execution-plan.md § TASK 0.6.2](../plan/05-execution-plan.md) · **Requirements:** C-06, C-07, NFR-01 · **Risks:** [R-08](../plan/02-risk-register.md) · **Decisions:** [D-19](../plan/01-decisions.md) · **Depends on:** 0.6.1

## What this covers

D-19's answer to "zero staging plus a bad merge takes production down": CI is the only gate (C-06 — there is no staging environment), so a bad deploy has to be caught and reverted automatically, in production, without a human watching. This task makes that real for the health Lambda — the only Lambda that exists today — establishing the pattern every future Lambda in this repo follows.

## What was built

All in `infra/src/web-stack.ts`, plus a new handler in `services/api/src/smoke-test.ts`:

- **A published Version + `live` Alias.** `healthFunction.currentVersion` is wired to a `lambda.Alias` named `live`. Both the HTTP API integration and CodeDeploy's traffic shifting now target the alias, never the bare function — the DoD's "Do NOT allow a deploy path that bypasses the alias" is structural, not a convention: nothing in this stack holds a reference to the bare `HealthFunction` for invocation anymore.
- **Two CloudWatch alarms scoped to the alias**, not the function: `HealthAliasErrorsAlarm` (≥1 error/minute) and `HealthAliasLatencyAlarm` (>3s average duration/minute, comfortably under the 5s function timeout). Scoping to the alias means these only reflect traffic actually reaching the *new* version during a canary window, not historical traffic on the old one.
- **`LambdaDeploymentGroup`** (`HealthDeploymentGroup`), `deploymentConfig: CANARY_10PERCENT_5MINUTES` — the task's literal "10% → 100% over 5 min": CodeDeploy shifts 10% of the alias's traffic to the new version, waits 5 minutes while the two alarms above watch it, then shifts the rest. The two alarms are wired in as `alarms`, which — combined with CDK's default `autoRollback` (unchanged, not overridden) — produces `AutoRollbackConfiguration: { Enabled: true, Events: [DEPLOYMENT_FAILURE, DEPLOYMENT_STOP_ON_ALARM] }`: either a tripped alarm *or* a failed deployment stops the shift and reverts the alias.
- **`services/api/src/smoke-test.ts`**, wired as the deployment group's `postHook` (CodeDeploy's `AfterAllowTraffic` lifecycle event — see "Why the smoke test runs after 100%, not during the canary" below). It fetches `https://next.nourishthenerve.com/health` and `https://next.nourishthenerve.com/` (the task's literal "a real page") and reports `Succeeded`/`Failed` back to CodeDeploy via `PutLifecycleEventHookExecutionStatusCommand`. A `Failed` report is what triggers the rollback proven below. Follows the same injectable-dependency pattern as `health.ts` (`Clock`, `RequestLogger`) — `Fetcher` and `LifecycleReporter` are both injected, so the real AWS SDK client and `fetch` are never exercised in unit tests.
- CDK grants everything this needs automatically: the deployment group's auto-created service role (`AWSCodeDeployRoleForLambdaLimited`) can invoke the smoke test function; the smoke test function's role can call `codedeploy:PutLifecycleEventHookExecutionStatus`, scoped to this one deployment group's ARN — confirmed by inspecting the synthesized IAM policy, not assumed.

### Why the smoke test runs after 100%, not during the canary

CodeDeploy's Lambda deployment lifecycle supports exactly two hooks: `BeforeAllowTraffic` (runs at 0%, before any shift) and `AfterAllowTraffic` (runs once the *entire* configured shift has completed — i.e., at 100%, not at the 10% canary step). A `BeforeAllowTraffic` hook can't validate anything about the new code from the public domain, because at that point 100% of traffic is still on the old version. So the smoke test is the `postHook`: it validates the new version once it's actually live, and its failure is what CodeDeploy reverts. The two CloudWatch alarms are the mechanism that can stop things earlier, during the 10% bake — they're evaluated continuously, independent of the hooks.

## A pre-existing bug this task found and had to fix first

Previewing the live `cdk diff` for this task surfaced that **production deploys had been silently failing since TASK 0.5.2** (PR #18, 2026-08-10): `budget-stack.ts`'s `LogIngestionVolumeAlarm` used a `MathExpression` built from a raw `SEARCH()` string. `cdk deploy --all` deploys `NdnBudgetStack` and `NdnWebStack` in one invocation and aborts on the first stack failure, so every push-to-main deploy since — 0.5.2, 0.5.3 (PR #19), and 0.6.1 (PR #20) — failed at `NdnBudgetStack` before `NdnWebStack` ever got a chance to update. Confirmed via `gh run view` on all three `deploy` job runs: identical failure each time —

```text
Resource handler returned message: "SEARCH is not supported on Metric Alarms.
(Service: CloudWatch, Status Code: 400, ...)"
```

— and via a real `cdk diff NdnWebStack`, which showed the live `HealthFunction` still missing TASK 0.5.2's own `LoggingConfig` change. Production had been stuck at (approximately) TASK 0.5.1's state for three merges.

**Root cause:** AWS's `PutMetricAlarm` API rejects *any* alarm math expression containing `SEARCH()` — confirmed twice against the real API, first with the original bare `SEARCH(...)`, then again after wrapping it in `SUM(...)` (a pattern that works for CloudWatch *dashboard* widgets but not alarms). The console's "create alarm from a search" flow doesn't do this either — it expands a search into one alarm *per matched metric*, not a single combined-total alarm, which was never actually what `budget-stack.ts` wanted.

**Fix (per explicit sign-off — this was a design fork, not a syntax fix):** `MONITORED_LOG_GROUP_NAMES` in `infra/src/config.ts` — an explicit list of log group names (today: `/ndn/health-function`, `/ndn/smoke-test-function`) — replaces the dynamic `SEARCH()`. `budget-stack.ts` now builds one named `AWS/Logs` `IncomingBytes` metric per entry and sums them with `FILL(m0, 0) + FILL(m1, 0) + ...` (the `FILL` matters: without it, one quiet log group with zero bytes that day would make the *entire* sum read as "missing data" for that period, not just that group's share). The trade-off this accepts: a new Lambda's log group needs adding to this list by hand — the same one-line discipline `createLogGroup()` call sites already require, so it rides along with ordinary code review rather than being a silent gap, unlike a standing metric-publishing Lambda (the fully-dynamic alternative), which was judged more infrastructure than a £0.00 guard has earned.

`infra/src/budget-stack.test.ts` was updated to assert the new shape (a `FILL(...) + FILL(...)` expression plus one named per-log-group metric, not a `SEARCH.*` regex).

## Verification

### Local — CDK synth + unit tests, zero live AWS calls

`infra/src/web-stack.test.ts` (new `describe('WebStack — canary deployment (TASK 0.6.2)')` block) proves, from the synthesized CloudFormation template:

- The alias exists, named `live`, and both the API Gateway integration and its Lambda invoke permission target the alias's logical ID — not the bare function's.
- Both alarms exist, scoped to the alias (dimension `Resource: <FunctionName>:live`), with the right metric/statistic/threshold/comparison/missing-data treatment.
- The deployment group's `DeploymentConfigName` is `CodeDeployDefault.LambdaCanary10Percent5Minutes` and `DeploymentStyle` is `BLUE_GREEN`/`WITH_TRAFFIC_CONTROL`.
- Both alarms are wired into `AlarmConfiguration` (`Enabled: true`), and `AutoRollbackConfiguration` is `Enabled: true` with `DEPLOYMENT_FAILURE` and `DEPLOYMENT_STOP_ON_ALARM`.
- The alias's `UpdatePolicy.CodeDeployLambdaAliasUpdate.AfterAllowTrafficHook` references the smoke test function.
- The smoke test function's IAM role is granted exactly `codedeploy:PutLifecycleEventHookExecutionStatus`, scoped to this one deployment group's ARN — no broader access.
- The smoke test's log group has 14-day retention (R-11).

`services/api/src/smoke-test.test.ts` proves the handler logic with injected fakes: both checks 200 → `Succeeded`; either check non-200 → `Failed`; `fetch` throwing → `Failed`, not an uncaught rejection; a missing `SITE_DOMAIN` → `Failed` rather than defaulting to a pass.

`infra/src/budget-stack.test.ts` proves the corrected log-ingestion alarm shape (see above).

`pnpm -r lint && pnpm -r typecheck && pnpm -r test && pnpm run test:coverage && pnpm run audit` — all green: infra 46 tests (up from 15), services/api 76 tests (up from 69), coverage thresholds met (99.67% statements / 96.03% branches).

### Real AWS — both the fix and the rollback, proven end to end

**1. The `NdnBudgetStack` fix and this task's new infrastructure, deployed clean.** Direct admin-profile deploy (`AWS_PROFILE=ndn-prod npx cdk deploy --require-approval never --all` — the same command CI's `deploy` job runs), first time either stack had succeeded since PR #17 (0.5.1):

```text
NdnWebStack: 19/19 resources — CREATE_COMPLETE (87.55s)
  + HealthAlias, HealthFunction/CurrentVersion, HealthApplication, HealthDeploymentGroup,
    HealthAliasErrorsAlarm, HealthAliasLatencyAlarm, SmokeTestFunction (+ role/policy/log group)
NdnBudgetStack: 6/6 resources — UPDATE_COMPLETE (10.87s)
  + LogIngestionAlarmTopic, LogIngestionAlarmTopic subscription, LogIngestionVolumeAlarm

$ curl -s https://next.nourishthenerve.com/health
{"status":"ok","version":"local","timestamp":"2026-08-13T08:37:46.369Z"}
```

**2. The rollback — a deliberately broken build, deployed for real.** `services/api/src/health.ts`'s handler was temporarily changed to `throw new Error('deliberate failure for canary rollback demo')` (never committed — reverted immediately after, confirmed by an empty `git diff` and a `cdk diff` against the live stack showing zero drift once reverted), then deployed with `AWS_PROFILE=ndn-prod npx cdk deploy NdnWebStack --require-approval never`.

CloudFormation's own event stream shows the full sequence:

```text
09:39:27  Lambda::Alias HealthAlias  UPDATE_IN_PROGRESS  CodeDeploy deployment started: d-82EELWTXI
09:44:53  Lambda::Alias HealthAlias  CodeDeploy rollback deployment started: d-NEUBTTTXI
09:44:54  Lambda::Alias HealthAlias  UPDATE_FAILED
    "d-82EELWTXI failed. The deployment failed because one or more of the
     lifecycle event validation functions failed."
09:44:54  CloudFormation::Stack NdnWebStack  UPDATE_ROLLBACK_IN_PROGRESS
09:45:08  CloudFormation::Stack NdnWebStack  UPDATE_ROLLBACK_COMPLETE
```

`aws deploy get-deployment` on both CodeDeploy deployments confirms the mechanism precisely — the canary's 10% shift held for the full 5-minute bake (09:39:27 → 09:44:33, ~5m06s), the `AfterAllowTraffic` hook then failed, and the rollback that follows is CodeDeploy's own, not a CloudFormation retry:

```json
// d-82EELWTXI (the broken deploy)
["Failed", {"code": "HOOK_EXECUTION_FAILURE",
  "message": "The deployment failed because one or more of the lifecycle event validation functions failed."},
  "2026-08-13T09:39:27+01:00", "2026-08-13T09:44:33+01:00"]

// d-NEUBTTTXI (the automatic rollback CodeDeploy triggered)
["Succeeded", "2026-08-13T09:44:33+01:00", "2026-08-13T09:44:35+01:00"]
```

CloudWatch Logs close the loop end to end — the broken version really did serve, the smoke test really did catch it, and traffic really did move back:

```text
# /ndn/health-function — Version 2 (the broken build) invoked once, throws:
08:44:31 ERROR Invoke Error {"errorType":"Error","errorMessage":"deliberate failure for canary rollback demo", ...}

# /ndn/smoke-test-function — catches it, reports Failed:
08:44:33 {"level":"info","route":"smoke-test","statusCode":500,"durationMs":2825, "requestId":"d-82EELWTXI"}

# /ndn/health-function — a follow-up request now runs Version 1, not Version 2:
08:45:47 START RequestId: 331b108b-... Version: 1
08:45:47 END RequestId: 331b108b-...   (no error — the alias is back on the good version)
```

`aws cloudformation describe-stacks --stack-name NdnWebStack` → `StackStatus: UPDATE_ROLLBACK_COMPLETE` — a clean, non-stuck terminal state, not `UPDATE_ROLLBACK_FAILED`. `curl https://next.nourishthenerve.com/health` immediately after → `200 {"status":"ok",...}`. The health handler was reverted locally straight after (confirmed by an empty `git diff`), and a final `cdk diff NdnWebStack` against the live stack showed **zero drift** — CloudFormation's own rollback had already restored production to exactly this PR's intended state; no further deploy was needed.

This is the DoD's "rollback demonstrated, not described": a real broken build, deployed for real, caught by the real smoke test hitting the real public domain, reverted by real CodeDeploy, leaving the previous version verifiably still serving — not a mocked deployment group, not a synth-only assertion.

## Not done in this task (explicitly out of scope)

- **Ephemeral per-PR environments** (TASK 0.6.3) — a separate task; this one only makes the single production deployment path safe.
- **A metric-publishing Lambda for fully dynamic log-ingestion alarming** — considered and rejected as the fix for the pre-existing `SEARCH()` bug (see above); `MONITORED_LOG_GROUP_NAMES` is the accepted trade-off until that's worth building.
- **Canary/rollback for any Lambda other than the health function** — there isn't another one yet. The pattern (Alias + alarms + `LambdaDeploymentGroup` + a `postHook` smoke test) is the template for every Lambda Phase 1 onward adds.

## Cost

£0.00 net new, matching the plan. Two more CloudWatch alarms (`HealthAliasErrorsAlarm`, `HealthAliasLatencyAlarm` — first 10 alarms free, and this account was nowhere near that limit) plus the log-ingestion alarm fix (one more, still free). CodeDeploy has no charge for Lambda deployments. The smoke test Lambda runs at most a few times per deploy, well inside the always-free 1M requests/month. No new always-on infrastructure.

## Rollback (of this task's own infrastructure, not the mechanism it builds)

- **`WebStack`'s canary infrastructure:** revert the commit and redeploy — `cdk deploy` removes the alias, alarms, deployment group, and smoke test function, restoring direct function-to-API-Gateway wiring (the pre-0.6.2 shape). No data is touched; the site bucket and its content are untouched.
- **`BudgetStack`'s alarm fix:** reverting to the `SEARCH()`-based expression would simply reintroduce the deploy-blocking bug proven above — there is no reason to.
- Both changes are additive-only against the live account (confirmed by `cdk diff` before either deploy above) and were proven, live, to roll back cleanly should a future deploy of either stack ever need to.
