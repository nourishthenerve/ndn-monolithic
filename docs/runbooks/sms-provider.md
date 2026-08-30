# SMS provider: AWS End User Messaging (TASK 2.3.2)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.3.2](../plan/05-execution-plan.md) · **Requirements:** C-02, NFR-09 · **Decisions:** ADR-0008 (resolved by this task), D-11, **amended by D-32** · **Risks:** [R-01, R-02](../plan/02-risk-register.md) · **Long-lead:** LL-02 (closed as moot) · **Depends on:** 2.3.1, 0.5.3, 0.5.1

## Amendment, D-32 (2026-08-30) — unreachable, not deleted

This platform's only SMS template, named throughout this file — the appointment reminder — is deleted along with the sweep that sent it (TASK 3.4.3, D-32). No code path calls `SmsProvider`/`createAwsEndUserMessagingSmsProvider` any more. Everything below is kept as the historical record of the real provider decision and its live pricing proof; nothing here is wrong, it is simply unreachable — the same "dark, unreachable, not removed" posture D-31 already holds for Stripe. LL-02 (leasing a real UK SMS identity) is closed as moot for the same reason.

## What this covers (as originally built — see the amendment above for its current status)

[`sms-hard-cap.md`](sms-hard-cap.md) (TASK 0.5.3) built every guard an SMS send has to pass and proved, by construction, that "there is no code path here, in a test or otherwise, that can send a real SMS." This task is the one that changes that sentence: it re-verifies both candidate providers' live UK prices, chooses one, and wires it in behind those same guards, in the same order, adding one call at the end of the chain rather than moving anything that was already there.

## What was built

- **[`docs/adr/0008-sms.md`](../adr/0008-sms.md)** — the decision itself, with both re-verified prices (AWS End User Messaging $0.035/message, Twilio $0.056/message — both fetched live 2026-08-22, method and dated in the ADR), the total-cost comparison including origination overhead, and why AWS's rate specifically closes R-01's modelled shortfall (£5 now covers ≈172 messages/month against the plan's own ~150/month estimate, not ≈108).
- **`services/api/src/sms-provider.ts`** — `SmsProvider`, a one-method port (`send({ to, body }): Promise<void>`), and `createAwsEndUserMessagingSmsProvider`, its real implementation against `@aws-sdk/client-pinpoint-sms-voice-v2`'s `SendTextMessageCommand`. `DestinationPhoneNumber` is E.164 — re-verified against the AWS API reference, and it is exactly `normalizeUkE164`'s own output format, so no second translation exists. `MessageType` is always `TRANSACTIONAL` (this platform's only SMS template is the appointment reminder — never promotional). `MaxPrice` defaults to $0.10/message: a per-message backstop independent of the account-level spend limit, refusing a send outright if a provider-side price surprise exceeds it.
- **`services/api/src/sms.ts`** — `SmsSenderDeps` gained a required `provider: SmsProvider`. `createSmsSender`'s guard order is unchanged (flag/kill-switch → allow-list → rate limiter → spend cap); the provider is called once, after all four have passed. A provider failure is caught and returned as a new typed status, `ProviderError`, rather than left to throw — every other branch in this function has always returned a typed result, never an exception, and a provider outage doesn't get to be the first exception to that rule.
- **`services/api/src/notifications.ts`** — `SendSmsParams` gained a `body: string` field (the rendered SMS text; `sms.ts` renders nothing itself, it only forwards what it's given). The Notifier's `smsEligible` branch now passes `rendered.smsBody` through. `ProviderError` degrades to email exactly like `Capped`/`Blocked`/`NotUk`/`RateLimited` — one more named reason on the same path, not a new one.
- **`docs/plan/03-cost-model.md`, `docs/plan/09-self-audit.md`, `docs/plan/02-risk-register.md`** — the SMS cost line split into message spend ($0.035/msg) and a new $2.00/month origination-lease line; the self-audit's `UNVERIFIED` list lost its AWS-SMS entry; R-01's likelihood revised from High to Medium on the corrected arithmetic (impact stays High — a missed clinical reminder is exactly as bad either way, it is just less likely to be forced by the cap alone now).

## What was deliberately not built here

- **No UK long code is actually leased, and no AWS/Twilio account was created or configured.** Everything above is real, tested code — against a mocked AWS SDK client, the same discipline `ses.ts`'s tests already use — but `createAwsEndUserMessagingSmsProvider` needs a real `originationIdentity` to send anything, and none exists.
- **UK long-code provisioning is LL-02** (`docs/plan/08-long-lead.md`): owner-owned, 2–4+ weeks, and should start now rather than at the end of some later task. It is now "provision a UK long code via AWS End User Messaging SMS," not a Twilio sender-ID registration — the provider named in LL-02 changes with this ADR, the timeline and ownership don't.
- **The provider-side account spend limit** (D-11's backstop, alongside the app-level £5 cap) is an AWS-account configuration set once the account and origination identity exist — an owner action, same shape as `ses-production-access.md`'s SES request (LL-01).
- **A sandbox proof against the real provider** (the task's step 7) is proven today only against the mocked SDK client (`sms-provider.test.ts`, `sms.test.ts`'s `ProviderError` case) — a live-account proof isn't possible before LL-02 provisions one.
- **The anomalous-velocity alarm** (R-02's fifth mitigation) needs a real CloudWatch metric on real send volume, which doesn't exist until something calls this code path in production — nothing does yet; TASK 3.4.x builds the appointment-reminder schedule that will.
- **Nothing calls `Notifier.send` in production**, unchanged from 2.3.1 — this task makes a real send *possible*, not *scheduled*.

## Verification

`services/api/src/sms-provider.test.ts` (new), `sms.test.ts` (updated), `notifications.test.ts` (updated) — zero live AWS calls, zero real SMS sent:

- The provider sends exactly one `SendTextMessageCommand`, `TRANSACTIONAL`, with the default `MaxPrice`; a caller-supplied configuration set and `MaxPrice` are passed through; a provider error propagates rather than being swallowed (`sms-provider.test.ts`'s job — `sms.ts`'s job is deciding what to do with it).
- `createSmsSender` calls the provider exactly once, with the normalised E.164 destination and the rendered body, only after every guard has passed; every rejection path (`Blocked`/`NotUk`/`RateLimited`/`Capped`) never reaches the provider at all; a provider throw becomes `ProviderError` without the rate-limit slot or spend-cap amount already committed being un-committed (they aren't refunded — a provider outage is not free to retry against the cap).
- `notifications.test.ts`'s existing degradation suite (2.3.1) gained a `ProviderError` case, proving the Notifier degrades to email and names the reason exactly like every other SMS failure mode.

`pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

## Cost

£0.00 this month, as the task's own line states — no account, no origination identity, no reminder yet exists to send (3.4.x). Modelled forward cost, once LL-02 completes and 3.4.x starts sending: see `docs/plan/03-cost-model.md`'s split SMS lines and `docs/adr/0008-sms.md`'s total-cost comparison.
