# SMS hard-cap mechanism (TASK 0.5.3)

**Date:** 2026-08-10 · **Task:** [05-execution-plan.md § TASK 0.5.3](../plan/05-execution-plan.md) · **Requirements:** C-02, C-11, NFR-09 · **Risks:** [R-01, R-02](../plan/02-risk-register.md) · **Depends on:** 0.5.1

## What this covers

R-02's five named mitigations for SMS pumping fraud — "+44-only destination allow-list, per-principal rate limit, hard block at cap, anomalous-velocity alarm, SMS only behind authentication" — and R-01's "never silently drop a reminder" — land now, before any SMS provider is chosen (ADR 0008: provider selection is M2.2) or any SMS can physically be sent. The cap therefore can never be breached even once: there is nothing yet that calls a provider.

## What was built

All in `services/api/src/`, following the same interface-seam pattern `store.ts`/`audit.ts` already established for infrastructure that doesn't exist yet — a real backing implementation can satisfy the same interface later without callers changing:

- **`sms-allow-list.ts`** — `normalizeUkE164(raw)`. Accepts UK national (`07...`), international-without-plus (`447...`) or already-E.164 (`+447...`) input and normalises to a branded `E164` UK-mobile string, or `undefined`. Validates full structure (`/^\+447\d{9}$/`) rather than a `startsWith('+44')` prefix check, so a spoof like `+4401234567890` (the national `0` pasted straight after `+44`) is rejected rather than waved through.
- **`sms-spend-cap.ts`** — `SpendCounterStore.tryAdd(monthKey, amountPence, capPence)`: an atomic check-then-commit that never partially applies. `SMS_MONTHLY_CAP_PENCE = 500` (C-02's £5). `InMemorySpendCounterStore` is today's implementation; a DynamoDB-backed one (`ConditionExpression`-guarded `UpdateItem`) can satisfy the same interface once M2.2 actually sends anything. `currentMonthKey(now)` keys the counter by UTC `YYYY-MM`.
- **`sms-rate-limiter.ts`** — `RateLimiter.tryConsume(principal)`: a fixed-window limiter, `InMemoryRateLimiter` today. Defaults (`SMS_RATE_LIMIT_PER_PRINCIPAL = 5` per `SMS_RATE_LIMIT_WINDOW_MS` = 1 hour) sized around R-01's actual use case — a single 1-hour appointment reminder per principal — so a burst well past that is a clear signal of abuse, not ordinary use.
- **`sms-flags.ts`** — `SmsFlagReader.read(): Promise<{ enabled, killSwitchEngaged }>`. `enabled` is the task's own `sms.enabled` flag (default off). `killSwitchEngaged` is a second, independent gate: an operator can stop all sending immediately without a deploy, even after `sms.enabled` is on. Both default to the safe (nothing sends) state. `InMemorySmsFlagReader` is today's implementation; both will move to SSM Parameter Store (D-14) once the generic, cached flag store (TASK 0.6.1) lands — this task doesn't duplicate that infrastructure early, it only defines the seam 0.6.1 will fill.
- **`sms.ts`** — `createSmsSender(deps)` returns `sendSms(params): Promise<SendSmsResult>`, gating in order: kill switch / flag off → `Blocked`; destination not a valid UK mobile → `NotUk`; principal over its rate window → `RateLimited`; month over the £5 cap → `Capped`; otherwise → `Sent`. It calls no SMS provider — there isn't one yet — so no code path here, in a test or otherwise, can send a real SMS.

## What was deliberately not built here

- **The SMS provider integration itself.** ADR 0008 defers provider choice to M2.2, after re-verifying UK pricing. `sendSms`'s `Sent` branch is the seam that call will occupy.
- **A live DynamoDB table or SSM parameters.** Consistent with `store.ts`'s existing precedent ("no DynamoDB table is deployed yet"), the atomic counter and flag reader are proven as interfaces with in-memory implementations. Deploying the real backing infrastructure now, with nothing yet writing to it, would be infrastructure ahead of use.
- **The provider-side monthly spend limit** (step 5 of the task) — an independent backstop configured directly with the provider account. Not actionable until a provider is chosen at M2.2; tracked there.
- **The anomalous-velocity alarm** (R-02's fifth mitigation) — CloudWatch metrics on real send volume, which don't exist until there are real sends. Tracked alongside M2.2.

## Verification

`services/api/src/sms-allow-list.test.ts`, `sms-spend-cap.test.ts`, `sms-rate-limiter.test.ts`, `sms-flags.test.ts`, `sms.test.ts` — 28 tests, zero live AWS calls, zero real SMS sent:

- **Allow-list:** UK national/international/E.164 forms all normalise identically; spaces/hyphens/parens stripped; non-UK (`+1`, `+33`) and the `+4401...` spoof rejected; UK landline (non-mobile) range rejected; wrong-length numbers rejected.
- **Spend cap:** boundary at £4.99/£5.00/£5.01 (499p/500p/501p against the 500p cap) exactly as the task specifies; a rejected add applies nothing (proven by a follow-up add for the full cap still succeeding); independent totals per month key; **200 concurrent 5p adds against the 500p cap commit exactly 100 and reject the rest, with the 101st add afterwards still rejected** — proving no overshoot under contention.
- **Rate limiter:** allows up to the configured limit within a window then blocks; tracks each principal independently; resets once the window elapses (via an injected, advanceable `Clock`).
- **Flags:** defaults to `{ enabled: false, killSwitchEngaged: false }`; reflects patches; accepts an explicit initial state.
- **Orchestrator (`sms.test.ts`):** sends on the happy path; `Blocked` when the flag is off (the default); `Blocked` by the kill switch even with the flag on; `NotUk` for a non-UK destination, and — critically for R-02 — the rejected attempt does **not** consume a rate-limit slot; `RateLimited` once a principal's window is exhausted; `Capped` once the monthly total is reached.

`pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green (services/api: 64 tests, up from 36; infra, workers, tests unchanged).

## Cost

£0.00, as planned — no infrastructure deployed, no SMS provider account exists yet, and no SMS is sent by any code path introduced here.
