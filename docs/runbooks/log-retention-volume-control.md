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
