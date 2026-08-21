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

## SSM-backed flag source — added 2026-08-21 (TASK 1.6.2)

**This section supersedes "What was deliberately not built here" above.** That deferral was right in TASK 0.6.1 — nothing deployed then read a flag. It stopped being right at TASK 1.3.1, when the first flag-gated Lambda shipped, and it was not revisited: nine handlers went to production each wiring an `InMemoryFlagSource` that nothing ever wrote to, so every flag read `false` forever and no operator action could change it. The Gate G1 review found and quantified that ([gate-g1-report.md](../plan/gate-g1-report.md) §3a); this is the fix.

### How to turn a flag on

One SSM parameter per flag, named `/ndn/flags/<FlagName>`, holding exactly `true` or `false`:

```bash
aws --profile ndn-prod ssm put-parameter \
  --name /ndn/flags/contact.form.enabled \
  --type String --value true --overwrite
```

Live within **30 seconds** — `FLAG_CACHE_TTL_MS`, the in-process cache each warm Lambda holds. No deploy, which is the whole point of D-23. To turn it off again, `--value false` (or delete the parameter; both read as off).

`--type String`, not `SecureString`: a flag's state is not a secret, and `WithDecryption` would need a KMS grant for nothing.

### The flags that exist

Every name in `FlagName` (`services/api/src/flags.ts`) is a valid parameter suffix. As of this task:

| Flag | Gates |
|---|---|
| `content.readApi.enabled` | `GET /content` — the public blog read API |
| `content.authoring.enabled` | blog authoring/publish/unpublish |
| `contact.form.enabled` | `POST /contact` |
| `testimonials.submission.enabled` | public testimonial submission |
| `testimonials.moderationQueue.enabled` | the admin moderation queue |
| `workshops.enabled` | workshop read + authoring |
| `payments.stripeCheckout.enabled` | Stripe Checkout session creation (also gated on LL-03) |
| `sms.enabled`, `sms.killSwitchEngaged` | SMS sending (no sender wired yet — M2.2) |

**All of them are off right now**, and deliberately so: no parameter exists for any of them. This task restored the ability to turn them on; it turned nothing on. Enabling any of them is a separate, deliberate decision — and for the two form-backed ones, it should not happen before the Turnstile test key is replaced with a real one ([contact-form.md](contact-form.md)).

### How it fails

Fail-closed at every step, because the alternative is a config read taking a working page down:

| Situation | Result |
|---|---|
| No parameter (today's steady state) | flag off, no log line — this is the normal answer, not an error |
| Value is exactly `true` / `false` | flag on / off |
| Value is anything else (`True`, `1`, `yes`, empty) | flag **off**, one `flags.ssm_unrecognised_value` warning naming the parameter (never its value) |
| SSM throttles, errors, or is unreachable | flag **off**, one `flags.ssm_read_failed` warning with the error name |

The unrecognised-value case is warned rather than silently coerced precisely so that someone who typed `True` and believed they had turned a feature on finds out.

### IAM

`infra/src/flag-parameters.ts`'s `grantFlagReads` gives each flag-reading role `ssm:GetParameter` on `parameter/ndn/flags/*` — a wildcard over the prefix, not one statement per flag, because naming flags individually would mean a deploy before every flip, reintroducing exactly the coupling this removes. The wildcard stops at the `flags/` segment, so it cannot reach `/ndn/admin-api-token`, `/ndn/stripe-secret-key`, `/ndn/stripe-webhook-secret` or `/ndn/turnstile-secret-key`. There is an infra test asserting that specifically.

Nine functions hold the grant: contact-form and media-upload (`NdnWebStack`); content-read, content-authoring, testimonial-submission, testimonial-moderation, workshop-read, workshop-authoring and workshop-checkout (`NdnDataStack`). The health and smoke-test functions deliberately do not, and a test asserts they never gain it.

### Verification

- `services/api/src/ssm-flag-source.test.ts` — 13 tests: prefix construction, no `WithDecryption`, `true`/`false` parsing, missing parameter is quiet, six unrecognised values each warn and fall back, an SSM error never throws, values are never logged, the cache spares SSM on a warm container, and an unreachable SSM leaves flags off rather than erroring.
- `infra/src/data-stack.test.ts` / `web-stack.test.ts` — 5 tests: all nine functions carry the prefix env var, all nine grants are exactly `ssm:GetParameter` on `parameter/ndn/flags/*`, no grant reaches a secret parameter, and the flagless functions stay flagless.
- Full suite green: 577 tests / 81 files (was 559 / 80).

### Cost

£0.00. SSM Standard parameters and Standard-throughput `GetParameter` are free. At a 30-second TTL, a warm container makes at most 2 calls/minute per flag it reads, and the Lambdas are near-idle.
