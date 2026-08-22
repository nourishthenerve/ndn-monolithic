# Notification abstraction (TASK 2.3.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.3.1](../plan/05-execution-plan.md) · **Requirements:** §5 (notifications), C-02 · **Decisions:** D-10, ADR-0009 · **Risks:** [R-01](../plan/02-risk-register.md) · **Depends on:** 2.2.3, 1.4.1

## What this covers

D-10 makes email the primary channel and SMS the exception, and R-01 is the arithmetic behind it: §5 asks for ~150 SMS/month and C-02's £5 buys ~108. The register's mitigation ends on "never silently drop a reminder" — a property this task builds as code, not policy: `Notifier.send` is the one function anything wanting to notify a patient calls, and every branch through it appends a delivery record before returning. There is no path that returns silently.

## What was built

All new, in `services/api/src/` and `packages/i18n/src/notifications/`:

- **`packages/i18n/src/notifications/index.ts`** — the template registry. `NotificationTemplateDef { id, category: 'clinical' | 'marketing', smsEligible, subjectKey, emailBodyKey, smsBodyKey? }`. Two templates exist today: `appointmentReminder1Hour` (`clinical`, `smsEligible: true` — the one template D-10 names) and `marketingNewsletter` (`marketing`, `smsEligible: false`, proving the machinery differentiates channel and category correctly). Re-exported from `@ndn/i18n`'s root (`export * from './notifications/index.js'`) rather than a new subpath — the package's `exports` map declares only `.`, and adding a second entry point for one file wasn't worth it.
- **`packages/i18n/src/locales/en.json`** — the four message keys the two templates above name. Rendered through `t()`, the same catalogue lookup every other string in the platform goes through, so a notification is translatable the day a second locale exists (D-04) and never carries a literal string.
- **`services/api/src/notification-templates.ts`** — `renderNotification(id, vars, locale?)` → `{ subject, emailBody, smsBody? }`, and `templateDef(id)` for the registry entry itself.
- **`services/api/src/notification-log.ts`** — `DeliveryRecord { at, recipientId, template, channel, outcome, reason? }` and the `DeliveryLog` interface `Notifier` writes through. `InMemoryDeliveryLog` is today's implementation — following `store.ts`'s precedent, a durable one can satisfy the same interface later; nothing sends a real notification yet, so nothing needs a durable log yet either. Identifiers only, same discipline as `audit.ts`: no address, no phone number, no message body is ever a field on this type.
- **`services/api/src/notifications.ts`** — `createNotifier(deps): Notifier`, `Notifier.send(recipient, template, vars): Promise<DeliveryRecord>`. The policy:
  1. A `marketing`-category template checks `recipient.marketingOptIn` first. Declined → one `failed`/`MarketingOptOut` record, nothing sent. A `clinical` template has no such check — there is no code path that reads `marketingOptIn` for one.
  2. A `smsEligible` template is attempted over SMS first, through `sms.ts`'s existing guard chain (`createSmsSender` — flags, the +44 allow-list, the per-principal rate limit, the £5 monthly cap, all built at TASK 0.5.3 and unchanged here). Success → one `sent`/`sms` record.
  3. When SMS is unavailable for any reason — `Blocked`, `Capped`, `NotUk`, `RateLimited` — the send degrades to email and the record says which reason, outcome `degraded` if the email itself sends, `failed` if it doesn't.
  4. Every other template (today: `marketingNewsletter`, once opted in) sends over email only. `outcome: 'sent'` on success, `'failed'`/`EmailSendFailed` if the SES call throws.
  5. `sendEmail` is caught internally — a failed send never throws out of `Notifier.send`; it is recorded and returned instead, so a caller cannot skip writing a record by forgetting to catch.
- **`services/api/src/ses.ts`** — `createSesGenericEmailSender`, a third SES sender alongside the existing contact-form and workshop-confirmation ones, this time with a caller-supplied subject and body rather than fixed content. This is the concrete `EmailSend` the composition root wires into `createNotifier` once something actually calls it.
- **`services/api/src/patient-repository.ts`** — `notificationRecipientFor(patient)`, a pure projection from a `Patient` record onto `NotificationRecipient { id, email, phone?, marketingOptIn }`. `personal{}` already carries everything a recipient needs (`marketingOptIn` has existed since 2.2.3) — this is the reuse the task's step 3 asks for, not a new preference field.

## What was deliberately not built here

- **Anything that calls `Notifier.send`.** "Nothing schedules anything: this task builds the sender." The appointment-reminder *schedule* is TASK 3.4.x's, once an appointment entity exists to schedule against — building it here would mean guessing at a model that doesn't exist yet.
- **A durable delivery log.** Same reasoning as `sms-hard-cap.md`'s: deploying real backing infrastructure with nothing yet writing to it in production is infrastructure ahead of use. `InMemoryDeliveryLog` is the seam.
- **Bounce/complaint-driven "this address is unreachable" state.** The SES configuration set (`infra/src/email-events.ts`) already publishes bounce/complaint events to an SNS topic with a human subscriber (TASK "SES bounce/complaint events, reputation alarms, configuration set"). Wiring that topic to mark a recipient's email unreachable — so a future send degrades rather than repeating into a void — is a Lambda subscribed to that topic plus a store keyed by recipient, neither of which exists yet; it is real, separate, infra-touching work, sized on its own rather than folded into this task silently.
- **The SMS provider itself.** `sms.ts`'s guard chain still calls no provider — `Notifier`'s SMS attempt runs the same chain 0.5.3 built and proved, and TASK 2.3.2 is what makes its `Sent` branch real.
- **Migrating the three existing SES call sites** (`contact-form-handler.ts`, `stripe-webhook-handler.ts`, `post-confirmation.ts`'s registration email) onto `Notifier`. They predate this abstraction and are not notifications a patient's preferences or SMS eligibility apply to in the same way; moving them is a separate, deliberate change, not a side effect of this one.

## Verification

`packages/i18n/src/notifications/index.test.ts`, `services/api/src/notification-log.test.ts`, `notification-templates.test.ts`, `notifications.test.ts`, plus an added case in `patient-repository.test.ts`:

- The registry has exactly one `smsEligible` template, and every `smsEligible` template has an `smsBodyKey` while every other template has none.
- Every declared template key resolves to non-empty content in the `en` catalogue.
- `appointmentReminder1Hour` sends over SMS on the happy path, with no email call.
- SMS unavailable for each of `Capped`, `Blocked`, `RateLimited` and `NotUk` (including "no phone on file", which the SMS guard's own normaliser turns into `NotUk`) all degrade to email, and the record names the reason.
- A failed email fallback after an unavailable SMS records `failed`/`EmailSendFailed`, not a silent drop.
- `marketingNewsletter` never reaches the SMS path, even with the SMS sender stubbed to always succeed.
- An opted-out recipient's marketing send is silenced and recorded as `failed`/`MarketingOptOut`; the same recipient's clinical/SMS-eligible send is untouched by that preference.
- No `DeliveryRecord`, on any branch, contains the recipient's email, phone number, or any rendered template content (asserted by serialising every record produced across all of the above and checking none of those substrings appear).

`pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

## Cost

£0.00 net-new. No infrastructure deployed; SES volume for anything this eventually sends sits inside `03-cost-model.md`'s existing line ($0.05/$0.18/$0.30); no SMS is sent by any code path introduced here.
