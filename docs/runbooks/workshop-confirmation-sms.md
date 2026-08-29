# Workshop confirmation: phone collection + SMS-first delivery

**Task:** workshop-confirmation-sms · **Decisions:** ADR-0008, ADR-0009, D-10, **superseded by D-31** · **Depends on:** 1.5.2, 2.3.1, 2.3.2, 3.4.3

## Abandoned before its first real use — D-31 (2026-08-29)

**This entire task is moot.** It hardened workshop registration confirmations against SES's sandbox restriction — but D-31 abandons workshop registration itself before its first real use: no online registration exists on the website at all, so no confirmation of any kind, SMS or email, is ever sent. The `workshopRegistrationConfirmation` `smsEligible` template this task built is unreachable code, the same "dark, unreachable, not removed" posture every other superseded mechanism in this codebase holds. Full reasoning: [01-decisions.md](../plan/01-decisions.md)'s D-31.

## Why this ran (as originally built — see the note above for its current status)

SES production access remains denied (`docs/runbooks/ses-production-access.md`, case `178661888300813`, denied twice) — the account stays sandboxed, unable to send to any address outside the verified `nourishthenerve.com` domain. Workshop registration confirmations (TASK 1.5.2) go to arbitrary attendee addresses, so they'll fail outright once workshops go live. Appointment reminders already solve the equivalent problem by preferring SMS over email (ADR-0008, D-10). `docs/runbooks/notifications.md` named migrating the workshop-confirmation email onto that same `Notifier` abstraction as deliberately deferred, separate work — this is that work, done to cut reliance on SES as much as possible rather than wait on a third SES appeal.

## What changed

- `Registration` (`packages/shared-types/src/registration.ts`) gained an optional `attendeePhone`. Collected in the same request body as `attendeeEmail` at checkout (`stripe-checkout-handler.ts`'s `checkoutBodySchema`) — loosely bounded (max 32 chars, trimmed, empty treated as not given); no format validation at intake, since `sms-allow-list.ts`'s `normalizeUkE164` is the real gate at send time and duplicating it would be a second source of truth.
- A new notification template, `workshopRegistrationConfirmation` (`packages/i18n/src/notifications/index.ts`), `smsEligible: true` — the second such template (`appointmentReminder1Hour` was the first). Copy matches what the direct-SES send used to read verbatim.
- `stripe-webhook.ts`'s `checkout.session.completed` handler no longer calls SES directly — it calls the same `Notifier.send` appointment reminders use. SMS is tried first when `attendeePhone` is present and a valid UK mobile; any failure (missing/non-UK number, capped, rate-limited, blocked, provider error) degrades to email exactly as before this change, per the Notifier's own "never silently drop" property.
- `stripe-webhook-handler.ts`'s composition root now wires a real `Notifier` — same factories `reminder-sweep-handler.ts` already uses (`createSesGenericEmailSender`, `createSmsSender`, `DynamoSpendCounterStore`, `DynamoDeliveryLog`, `createAwsEndUserMessagingSmsProvider`) — no new abstractions.
- `infra/src/web-stack.ts`'s `StripeWebhookFunctionRole` gained `sms-voice:SendTextMessage` (unscoped for now, same temporary posture as `data-stack.ts`'s `SendReminderSms`, pending a leased identity ARN), `grantFlagReads` (the SMS guard chain reads feature flags via SSM), and the `NOTIFICATION_TABLE_NAME`/`SMS_ORIGINATION_IDENTITY` env vars. No new DynamoDB grant was needed — the existing `StripeWebhookWrite` statement is already an unconditioned table-wide `PutItem`/`UpdateItem`, which already covers the delivery-log and spend-cap partitions.
- `docs/plan/02-risk-register.md`'s R-01 row was updated for the combined SMS volume now sharing the £5/mo cap with appointment reminders (per the template registry's own stated convention: a second `smsEligible` template means redoing this arithmetic, not just flipping the flag).

## What this does not do

- **No frontend registration form.** There is still no page on the site that calls `POST /workshops/:id/checkout` at all — this was backend-only by explicit scope decision. Phone collection has nowhere to happen yet in practice.
- **Doesn't lease a UK SMS origination identity.** `SMS_ORIGINATION_IDENTITY` is still empty (LL-02, an owner action, 2–4+ weeks). Every SMS attempt fails at the provider and degrades to email until that's done — by design, no code change required when it is.
- **Doesn't touch `post-confirmation-handler.ts`/`ses-registration.ts`** — a different, Cognito-account-registration email, despite the similarly-named `createRegistrationEmailSender` export there.
- **Doesn't reduce production email volume today.** Workshops remain flag-gated off (`workshops.enabled`, `payments.stripeCheckout.enabled` both default off) — confirmed via `/workshops` still returning 404 in production at the time this was written.

## Rollback

Revert the branch. Nothing here is a one-way door: the new IAM statement grants a capability nothing can reach without a leased identity; the shared spend cap only ever degrades gracefully; no data migration is involved (the new `attendeePhone` field is additive and optional).
