# Load testing (TASK 5.1.1, TASK 5.1.2)

**Date:** 2026-08-27, updated 2026-08-28 · **Task:** [05-execution-plan.md § TASK 5.1.1](../plan/05-execution-plan.md), [§ TASK 5.1.2](../plan/05-execution-plan.md) · **Requirements:** NFR-05 · **Decisions:** [D-20](../plan/01-decisions.md) · **Risks:** [R-10](../plan/02-risk-register.md) · **Depends on:** 0.6.3, 4.5.1

## Status: HTTP baseline executed live; signalling-connect deliberately deferred

The disposable `LOAD_TEST=1` stack (`NdnLoadTestDataStack` + `NdnLoadTestWebStack`) was deployed for real on 2026-08-28, the HTTP baseline scenario was run against it end-to-end, and the stack was torn down afterward — `aws cloudformation list-stacks` confirms neither stack exists post-run. **`signalling-connect.yml` was not run.** Its own comment already names why a real `join` needs a live fixture this codebase doesn't have yet; the deeper reason found this run is upstream of that: `ws-authorizer.ts` denies every `$connect` outright while `video.signalling.enabled` is off, and that flag being off is production's own current, deliberate posture (TASK 5.5.3 turns it on last, after every other Phase 5 gate). Running the WS scenario at all would first require deciding to flip a real production capability early, purely to satisfy a load test — a call this runbook does not make unilaterally, named honestly here rather than worked around. TASK 5.1.1's own DoD ("a repeatable, documented 10×-derived load run has been executed") is met for the HTTP half; the WS half stays open pending that flag decision, which is TASK 5.5.3's to make, not this task's.

### HTTP baseline results (2026-08-28)

7 minutes, 6,900 requests, **0 failed**. `health` (30% weight, unauthenticated, unflagged) and `content` (70% weight, `content.readApi.enabled` — also off in production today, so every request hit the flag's own early-return path rather than a real `DynamoDB Query`, named honestly rather than presented as full end-to-end coverage):

| | p50 | p95 | p99 | max | vs NFR-05 (500ms) |
|---|---|---|---|---|---|
| Overall | 27.9ms | 39.3ms | 53ms | 1793ms (single outlier, first request) | **pass, 12.7x headroom at p95** |
| `health` (2xx) | 32.8ms | 43.4ms | 54.1ms | 268ms | pass |
| `content` (4xx, flag-off path) | 26.8ms | 34.8ms | 53ms | 1793ms | pass (see caveat above) |

CloudWatch Logs Insights against `/ndn/load-test/health-function`'s own `REPORT` lines (2,092 invocations): 3 cold starts, average `Init Duration` 105.6ms, max 113.31ms, execution-only p95 1.9ms. `content-read-function`'s own log group had **zero** log streams for the entire run despite 4,809 real requests — not a load-test artefact; see the new Follow-up section in [log-retention-volume-control.md](log-retention-volume-control.md) for why and its fix. `TARGET_WS_TOKEN` was never obtained (moot regardless, given the flag-deny above) — the shared clinician test identity's credentials live only as GitHub Actions secrets for TASK 5.3.1's own scheduled job, not anywhere this runbook's live-CLI steps can reach them, and creating a second, throwaway identity just to route around that was rejected as unnecessary risk to a shared fixture for a scenario that couldn't have connected regardless.

**Cost:** the 2026-08-28 run's own stack lifetime (~30 minutes total: deploy, 7-minute run, destroy) — DynamoDB `PAY_PER_REQUEST` at near-zero item count, ~6,900 Lambda invocations at 128MB/arm64, one CloudFront distribution and one WebSocket API provisioned but never invoked. Not separately added to `03-cost-model.md`: at this volume the one-off is a fraction of a cent, well inside the "modelled before the run, re-priced against the actual bill afterward" allowance this task's own header already carries, and `ndn-prod`'s monthly budget alarm (TASK 0.5.1) would have caught any real overrun.

## TASK 5.1.2 — Cold-start p95 finding (real, and worse than the HTTP baseline suggested)

**Status: a real NFR-05 finding, priced, not fixed — the decision is named, not taken here.** The HTTP baseline above only exercised `health` (no flag check) and `content` (flag off, short-circuits before any real work) — both fast even cold. Once [#115](https://github.com/nourishthenerve/ndn-monolithic/pull/115)'s log-write fix was live, direct `aws lambda invoke` calls against six real production functions — `content-read`, `workshop-checkout`, `clinician-admin`, `assignment`, `message`, `stripe-webhook` (bundle sizes 5.6KB–164KB, so not a bundle-size story) — told a different one: **every cold sample exceeded NFR-05's 500ms bar**, by a wide margin:

| Function | Init Duration | Handler Duration | Total (caller-perceived) |
|---|---|---|---|
| `content-read` | 294ms | 1087ms | **1381ms** |
| `content-read` (2nd cold sample, ~6 min later) | 271ms | 1221ms | **1492ms** |
| `workshop-checkout` | 456ms | 890ms | **1347ms** |
| `clinician-admin` | 582ms | 861ms | **1442ms** |
| `assignment` | 433ms | 876ms | **1309ms** |
| `message` | 439ms | 832ms | **1270ms** |
| `stripe-webhook` | 504ms | 152ms | **656ms** |

(Total = `Init Duration` + `Duration` — sequential, not overlapping, on a cold invocation; confirmed against `Billed Duration` matching their sum.) Contrast with `health-function`'s own 2,092 real samples from the HTTP baseline: 3 cold starts, avg `Init Duration` 105.6ms, **no separate handler-latency spike** — total comfortably under 500ms every time.

### Root cause — isolated, not guessed

`content-read`'s own application log line for the first cold sample: `"durationMs":755` — confirming the slowness is real handler-internal time, not a measurement artefact. Every affected function's handler calls `deps.flags.isEnabled(...)` (`ssm-flag-source.ts`) before doing anything else — one `GetParameterCommand` per flag, via a module-scope `SSMClient`. `health-function` is the one function in this codebase with no flag check at all, which is exactly why it's the one that stayed fast. Three follow-up invokes isolated the mechanism precisely:

| Condition | `content-read` latency |
|---|---|
| Cold environment, first-ever SSM call | 1087–1221ms |
| Warm environment, flag cache expired (>30s — `FLAG_CACHE_TTL_MS`) | **71.5ms** |
| Warm environment, flag cache hit (<30s, back-to-back) | **1.5ms** |

The SSM API round-trip itself is fast (71.5ms) once a connection exists. What's slow is the **first TLS/connection setup a fresh execution environment ever does** — a well-known Lambda cold-start cost, here landing entirely inside "flag check," the first real network call on the path for almost every route in this codebase.

### Scope: 26 of ~32 functions share this exact architecture

`grep -c 'grantFlagReads(this,'` across `data-stack.ts` (22) and `web-stack.ts` (4) — every one of those 26 functions checks a flag as an early step and is built on the identical `SSMClient`/`ssm-flag-source.ts` path the six sampled functions share. Only 6 were directly measured (a range of bundle sizes, all showing the same signature), not all 26 individually — the DoD's own "every route's p95 is measured" is met in *mechanism* (the cause is architectural, not per-function code, and applies uniformly) rather than in a literal per-function load run of all 26; named honestly rather than claimed as full coverage.

### Fix candidates — priced and named, none enabled

1. **Provisioned concurrency.** Live-priced against the real AWS Pricing API for `eu-west-2`, arm64, 2026-08-28 (`aws pricing get-products --service-code AWSLambda`, not estimated): **$0.0000038643/GB-second** standby + **$0.0000090167/GB-second** while invoked. One always-on 128MB (0.125GB) instance ≈ **$1.25/month**. Applied to all 26 flag-checking functions: **≈ $32–33/month** — against a modelled total of £8.69/month (`03-cost-model.md`, M12), this alone would roughly quadruple it. **Not enabled.** `03-cost-model.md` is deliberately left unchanged (this task's own Files line: only touch it "if a fix is enabled").
2. **A leaner bundle.** Not applicable here — bundles are already 5.6KB–164KB; the cost is connection setup, not parse time, so trimming code would not move this number.
3. **A genuine zero-ongoing-cost architectural option, named but not built.** Replacing the live per-invocation `SSMClient.send(GetParameterCommand)` with a push-based mechanism (the AWS Parameters and Secrets Lambda Extension's own local cache, or flags resolved into environment variables by a redeploy) would remove this cold-start cost entirely with no recurring spend — but it touches the request path of all 26 functions, which is a bigger, review-worthy change than this task's own S–M size, and is not something to push through unilaterally alongside a finding-and-pricing task. Left as a candidate for its own future task.
4. **Accept the miss now, revisit with real traffic.** Recommended. Production holds 6 test-fixture items today and every meaningful flag is off (§ Status above, and `09-self-audit.md`'s own "zero flag parameters" finding) — there is no real user experiencing this latency yet. The HTTP baseline's own evidence (0.14% cold-start rate for `health-function` under sustained 19 req/s) shows real, sustained traffic keeps environments warm; a route's *practical* p95 impact depends on its real invocation frequency once launched; a low-frequency route (`stripe-webhook`, `turn-credentials`) is more likely to stay cold-dominated than a high-frequency one, which is exactly why this needs real post-launch data, not a pre-launch guess, to size correctly. Spending ~$33/month provisioning capacity against traffic that doesn't exist yet is not justified today.

**Owner decision needed, not taken here:** whether to (a) accept this now and re-measure once TASK 5.5.3 flips real traffic on, (b) commission the architectural fix (option 3) as its own task before launch, or (c) selectively provision concurrency (option 1) for specific low-frequency, latency-sensitive routes only (e.g. `stripe-webhook`) rather than all 26. R-10's own clause — "cost shown to you rather than absorbed" — is honoured by pricing option 1 precisely and recommending against enabling it, not by picking silently.

## Status (original, 2026-08-27): mechanism built, live run not yet executed

This task's harness, its CDK ephemeral-mode extension, and its 10x-target derivation are built and verified by `cdk synth` and unit tests. **No load has actually been run against a deployed stack** — the account owner deferred the live deploy/run/teardown cycle (a real, if disposable, ~15–30 minute-each-way Cognito+CloudFront+DynamoDB provisioning) to a separate, explicit go-ahead. TASK 5.1.1's own DoD in `05-execution-plan.md` — "a repeatable, documented 10×-derived load run **has been executed**" — is therefore not yet met by this PR alone. TASK 5.1.2 (the cold-start p95 finding) cannot start until a real run exists to measure.

## A correction to TASK 5.1.1's own written Steps

The task as elaborated at Gate G4 said the disposable copy would be "`AuthStack` + `DataStack` + `WebStack` together." Building it found a real constraint the plan's own text hadn't accounted for: `infra/bin/app.ts`'s existing comment on `AuthStack` already states why an ephemeral copy of it is deliberately never created — "these pools are `RETAIN` plus deletion protection, so an ephemeral per-PR copy would be a directory nothing could clean up." Duplicating it for a load test would hit the exact same problem for the exact same reason.

It also turns out not to be necessary: `DataStack`'s and `WebStack`'s Lambdas resolve Cognito pool/client ids from `config.ts`'s own fixed constants, not from a CDK cross-stack reference to `AuthStack` — `infra/bin/app.ts`'s own comment on `AuthStack` confirms this directly ("the identifiers this stack exports reach the rest of the estate through `config.ts` rather than a CloudFormation export"). A disposable `DataStack`/`WebStack` pair therefore authenticates against the **same real, already-provisioned production Cognito pools** as everything else in this account, with no pool duplication needed. This is the corrected shape: **`DataStack` + `WebStack` only, ephemeral, no `AuthStack`.**

## What was built

### `infra/src/data-stack.ts` — a second, narrower ephemeral mode

Unlike `WebStack`'s own `ephemeral` (TASK 0.6.3 — one per open PR, several potentially concurrent, torn down within the same CI run), exactly one load-test copy of `DataStack` exists at a time, deployed and destroyed by a human running the steps below — so `DataStackProps.ephemeral` only needs to make `cdk destroy` actually work, not additionally guard against concurrent collisions:

- `DataTable`'s `removalPolicy` is `DESTROY` when `ephemeral: true`, `RETAIN` otherwise (production unchanged). PITR stays on either way — it governs recovery, not deletion.
- `prLabel` already existed on `DataStackProps` (added in anticipation, "Unused today," and never previously exercised) and already scopes every one of this stack's ~19 explicit log group names — this task is the first real caller.
- No other resource in `DataStack` needed a change: the WebSocket/HTTP APIs and every Lambda already destroy cleanly regardless of `ephemeral`.

### `infra/bin/app.ts` — the `LOAD_TEST` branch

`LOAD_TEST=1 cdk deploy --all` (bootstrap-role permitting) synthesizes exactly `NdnLoadTestDataStack` + `NdnLoadTestWebStack` — confirmed via `cdk synth` — no `NdnAuthStack`, no `NdnBudgetStack` (same reasoning `bin/app.ts` already gives for skipping `BudgetStack` on a per-PR stack: an account-wide alarm makes no sense for a stack that will not exist for long). `WebStack` needed no change at all — `table`/`authorizerFunction` were already optional pass-through props for exactly this "ephemeral WebStack wired to an ephemeral DataStack" shape (0.6.3's own doc comment already names the general case; TASK 5.1.1 is its first real caller).

### `tests/load/derive-targets.ts` — 10x, derived rather than guessed

Converts `03-cost-model.md`'s own **M12 monthly** volumes into a peak **concurrent** figure:

| | Monthly (M12, cost model) | Active-hours peak (×3) | ×10 |
|---|---|---|---|
| HTTP requests | 500,000/mo | ~6,818/hr | **~18.9 req/s**, sustained |
| Signalling calls | 500/mo | ~68/hr | **~68 concurrent connections**, steady-state (Little's Law: 68/hr × 60 connection-min/call ÷ 60 = 68) |

"Active hours" = 22 working days × 10 hours/day = 220 hours/month, not a 24/7 average — a clinic's real traffic concentrates in working hours, and averaging across all 720 hours in a month would understate every peak figure. "Peak-to-average ratio" = 3×, a commonly-cited rule of thumb for business-hour-concentrated traffic. Both are named, disputable assumptions, not hidden ones — see `derive-targets.ts`'s own comments. `derive-targets.test.ts` pins the exact numbers so a future change to either the cost model's volumes or these assumptions is caught by a failing assertion, not silently absorbed.

**This derivation and the YAML files below are not wired together automatically.** Artillery reads a static config file; if `03-cost-model.md`'s own volumes change, re-run `deriveLoadTargets()` (or the test) and edit `http-baseline.yml`/`signalling-connect.yml` by hand.

### `tests/load/http-baseline.yml` and `tests/load/signalling-connect.yml` — the scenarios

- **`http-baseline.yml`**: ramps to ~19 req/s across a health check (`WebStack`'s `HttpApi`) and a public content read (`DataStack`'s `ContentHttpApi` — a different host; `data-stack.ts`'s own header explains why it has no CloudFront behavior routing to it yet). Deliberately excludes `/contact` (sends a real email), `/auth/*` (real Cognito calls against a shared, account-wide rate limit — see the safety note below), and anything that writes an appointment/message row. A full authenticated-write load pass is out of this first scenario's scope, named honestly rather than attempted and mis-scaled.
- **`signalling-connect.yml`**: ramps to a steady ~68 concurrent WebSocket connections, held open for the modelled 60 connection-minutes each. Deliberately **connect-only** — a real `join` (TASK 4.2.1) needs a real scheduled test appointment inside its own window, a fixture that does not exist yet and that TASK 5.3.1 needs too; the two should share one fixture rather than each inventing a slightly different one. A connect→join→relay scenario is TASK 5.1.2's own job, once that fixture exists.

Both files were syntax- and wiring-verified locally (`artillery run -s` against an unreachable port, confirming a clean `ECONNREFUSED` rather than a config-parse error) — not run against a real target, per the deferral above.

### Root/`tests` package scripts

`pnpm run loadtest:http` / `pnpm run loadtest:signalling` (root, proxying to `@ndn/tests`). Both require `TARGET_CONTENT_API_URL`/`TARGET_WEB_URL` or `TARGET_WS_URL`/`TARGET_WS_TOKEN` respectively, set from the stack's own `cdk deploy` output once it exists — see **To actually run this** below.

### `pnpm-workspace.yaml` — three new `allowBuilds: false` entries

Adding `artillery` pulled in `@playwright/browser-chromium`, `protobufjs`, and `unix-dgram` as transitive devDependencies, each with its own install-time build script. Traced with `pnpm why <pkg>` — all three reach back to artillery's own **optional** features this repo does not use (a browser-based scenario engine, gRPC/OpenTelemetry cloud reporting, and a StatsD reporter; this runbook's scenarios use only the HTTP and WS engines, `local` platform, no `--record`). Denied rather than approved, following the existing `allowBuilds` convention in this file (`esbuild: true`, `unrs-resolver: true`) — declining a script this repo has no use for is a smaller trust surface than running it un-reviewed.

## What is still needed — owner decision, not owner action

Steps 2, 3 (for the HTTP scenario), 4 (HTTP half), and 5 below are done (2026-08-28 — see Status above). What's left is not a deferred *action* the way the whole list was before this date; it's a **decision**, and it belongs to TASK 5.5.3, not this task:

1. ~~Two real, permanent, clearly-labelled test identities~~ — the **clinician** identity exists (built for TASK 5.3.1, shared per this item's own original note). The **patient** identity is still not built, and building it alone would not unblock the signalling scenario below regardless (item 3 was never the actual blocker — see Status).
2. ~~`LOAD_TEST=1 npx cdk deploy --all`~~ — done, ~7 minutes to `CREATE_COMPLETE` on both stacks (faster than the 15–30 minute estimate; no `AuthStack` in the critical path, per this file's own correction above).
3. Sign in for a real `TARGET_WS_TOKEN` — not attempted. Moot on its own: `video.signalling.enabled` off means `ws-authorizer.ts` denies `$connect` before token validity is even checked (Status above). Revisit only once that flag decision is made.
4. ~~`pnpm run loadtest:http`~~ — done, results above. `pnpm run loadtest:signalling` — blocked on item 3/the flag decision, not on this task's own mechanism.
5. ~~`LOAD_TEST=1 npx cdk destroy --all`~~ — done; confirmed via `aws cloudformation list-stacks` that neither stack exists.
6. **The actual remaining decision:** whether `video.signalling.enabled` is turned on in a real or disposable environment before TASK 5.5.3's own deliberate go-live sequencing, specifically to let the signalling-connect scenario run. Until that's decided, TASK 5.1.1 stays HTTP-complete/WS-open rather than fully closed. **Superseded, 2026-08-28** — see the "TASK 5.1.2" section above: the cold-start finding is not the "no fix needed" outcome this line originally recorded. Direct-invoke measurements across six other real functions found every flag-checking route fails NFR-05's 500ms bar when cold; `health`/`content` (this line's original scope) were the two functions that happened *not* to share that failure mode, not evidence the rest pass too.

## A real safety note for whoever runs this

**SSM feature flags are account-wide, not stack-scoped** (`flag-parameters.ts`'s `FLAG_PARAMETER_NAME_PREFIX` is one fixed `/ndn/flags/` path) — the same fact `web-stack.ts`'s own ephemeral-mode comment already relies on for its two SES senders ("both senders are flag-gated off"). A load-test stack's Lambdas read the **same** flags production does. Before TASK 5.5.3's go-live flip, every flag is off, so this is moot. **After** it, running this load test with synthetic booking/messaging traffic against flags that are genuinely on in production risks a real SMS/email send, an inflated `EstimatedTurnRelayGB` reading, or real reminder-sweep activity — none of which this first pass's HTTP/connect-only scenarios trigger, but a future extension (TASK 5.1.2's own connect→join→relay scenario) must check explicitly before it exists.
