# Feature flags (TASK 0.6.1)

**Date:** 2026-08-13 · **Task:** [05-execution-plan.md § TASK 0.6.1](../plan/05-execution-plan.md) · **Requirements:** §10 · **Decisions:** [D-23](../plan/01-decisions.md) · **Depends on:** 0.4.1

## What this covers

D-23's homegrown, config-driven feature flags — the generic flag store `sms-flags.ts` (TASK 0.5.3) was written against in advance: its `SmsFlagReader` interface was explicitly the seam this task's implementation satisfies, so incomplete work (SMS sending, and anything else gated behind a flag from here on) can merge dark and be turned on later without a deploy.

## What was built

All in `services/api/src/flags.ts`, following the same interface-seam pattern `store.ts` and `sms-spend-cap.ts` already established for infrastructure that doesn't exist yet:

- **`FlagName`** — a union of every flag name the system recognises, so a typo is a compile error rather than a silently-false runtime read. Today: `'sms.enabled'`, `'sms.killSwitchEngaged'`.
- **`FlagSource`** — `read(name): Promise<boolean | undefined>`, the raw, uncached source of truth. `undefined` means the flag has never been set. `InMemoryFlagSource` is today's implementation; an SSM Parameter Store `GetParameter`-backed one (D-14) can satisfy the same interface later without callers changing.
- **`FlagReader` / `CachedFlagReader`** — the typed accessor everything reads through: `isEnabled(name): Promise<boolean>`. Wraps a `FlagSource` with an in-process TTL cache (`FLAG_CACHE_TTL_MS = 30_000`) keyed per flag name, using the injectable `Clock` (00-conventions.md: "time is injectable — no test reads the wall clock") rather than the wall clock, so no network round trip is needed on every request while a flag can still be flipped without a deploy. A flag that's unset, or that the source doesn't recognise, reads as `false` — the mechanism behind "default-off for every new flag".

`sms-flags.ts` gains **`GenericSmsFlagReader`**, the concrete implementation of the `SmsFlagReader` seam it defined in TASK 0.5.3: it reads `sms.enabled` and `sms.killSwitchEngaged` through a `FlagReader`. `sendSms` (`sms.ts`) is unchanged — it already depended on the `SmsFlagReader` interface, not a concrete class.

## What was deliberately not built here

- **A live SSM parameter or any AWS SDK client.** Consistent with `store.ts`'s precedent ("no DynamoDB table is deployed yet"), the flag store is proven as an interface with an in-memory implementation. Nothing deployed today reads a flag at runtime — the health Lambda takes no flag-gated path — so wiring a real `@aws-sdk/client-ssm` call now would be infrastructure ahead of use. The seam (`FlagSource`) is what an SSM-backed implementation will satisfy once a Lambda actually needs a live flag.
- **CDK resources for the flag parameters themselves**, for the same reason.

## Verification

`services/api/src/flags.test.ts` (3 tests) and additions to `sms-flags.test.ts` (2 tests):

- An unset flag defaults to `false`.
- The cache serves a stale-but-cached value up to and including the millisecond before the TTL elapses, then re-reads the source on the next call once it has (proven with an injected, advanceable `Clock`, not a real timer).
- Each flag name is cached independently.
- `GenericSmsFlagReader` defaults to the safe state (`{ enabled: false, killSwitchEngaged: false }`) when neither flag has ever been set, and reflects both flags once the underlying source has them.

`pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green (services/api: 69 tests, up from 64; every other workspace unchanged).

## Cost

£0.00, as planned — no infrastructure deployed; SSM Standard parameters (the tier this will use once wired to a real Lambda) are free up to the account's parameter-count limit regardless.
