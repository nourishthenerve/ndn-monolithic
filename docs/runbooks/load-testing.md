# Load testing (TASK 5.1.1)

**Date:** 2026-08-27 · **Task:** [05-execution-plan.md § TASK 5.1.1](../plan/05-execution-plan.md) · **Requirements:** NFR-05 · **Decisions:** [D-20](../plan/01-decisions.md) · **Risks:** [R-10](../plan/02-risk-register.md) · **Depends on:** 0.6.3, 4.5.1

## Status: mechanism built, live run not yet executed

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

## What is still needed before a live run — owner action / separate go-ahead

None of this was executed. In order, whenever authorised:

1. **Two real, permanent, clearly-labelled test identities** (one patient, one clinician) in production Cognito — the same fixture TASK 5.3.1 needs, so build it once and share it, not twice differently. Excluded from any real notification/marketing path.
2. `LOAD_TEST=1 npx cdk deploy --all` from `infra/` (bootstrap-role permitting) — expect **15–30 minutes**, mostly the Cognito-adjacent and CloudFront provisioning `WebStack`'s own resources always take.
3. Sign in as the test identities against the real (production) hosted UI to obtain real ID tokens for `TARGET_WS_TOKEN`; read `ContentHttpApiUrl`/`DistributionDomainName`/`SignallingWebSocketUrl` from the deploy's own `CfnOutput`s for the other environment variables.
4. `pnpm run loadtest:http` and `pnpm run loadtest:signalling`, capturing p50/p95/p99 latency, error rate, and DynamoDB/Lambda throttle counts per route (TASK 5.1.1's own DoD).
5. `LOAD_TEST=1 npx cdk destroy --all` — confirm via `aws cloudformation describe-stacks` that both stacks reach `NOT_FOUND`/`DELETE_COMPLETE`.
6. Add the one-off run-cost line to `03-cost-model.md` (TASK 5.1.1's own Steps) and hand the p95 figures to TASK 5.1.2.

## A real safety note for whoever runs this

**SSM feature flags are account-wide, not stack-scoped** (`flag-parameters.ts`'s `FLAG_PARAMETER_NAME_PREFIX` is one fixed `/ndn/flags/` path) — the same fact `web-stack.ts`'s own ephemeral-mode comment already relies on for its two SES senders ("both senders are flag-gated off"). A load-test stack's Lambdas read the **same** flags production does. Before TASK 5.5.3's go-live flip, every flag is off, so this is moot. **After** it, running this load test with synthetic booking/messaging traffic against flags that are genuinely on in production risks a real SMS/email send, an inflated `EstimatedTurnRelayGB` reading, or real reminder-sweep activity — none of which this first pass's HTTP/connect-only scenarios trigger, but a future extension (TASK 5.1.2's own connect→join→relay scenario) must check explicitly before it exists.
