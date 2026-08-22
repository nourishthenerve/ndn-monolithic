# The 1-hour reminder, GSI4, and the first real SMS send (TASK 3.4.3)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.4.3](../plan/05-execution-plan.md) · **Requirements:** C-02, NFR-09, R-01, R-02 · **Decisions:** D-10, D-11 · **Risks:** R-01, R-02 · **Depends on:** 3.4.1, 2.3.1, 2.3.2

## What this covers

`02-risk-register.md`'s R-01 names the arithmetic directly: "§5 asks for ~150 SMS/month; C-02's £5 buys ~108" at scale, mitigated by "email-primary; SMS reserved for the 1-hour reminder … never silently drop a reminder — built as a property of the notification abstraction at 2.3.1." TASK 2.3.2 built and proved a real SMS send against a real provider but noted its own cost line as "£0.00 this month — no reminder exists to send until 3.4.x." This is that task, and it is the first time this platform sends an SMS anyone will actually receive.

An EventBridge scheduled rule (`rate(15 minutes)`) invokes `reminder-sweep-handler.ts`, which finds every scheduled, not-yet-reminded appointment starting within the next 75 minutes (GSI4), atomically claims each one, and sends `appointmentReminder1Hour` through TASK 2.3.1's `Notifier` — the same abstraction every other notification in this codebase already goes through, exercised over SMS for the first time.

## GSI4, proved before code — and a real consequence of `KEYS_ONLY` worth stating plainly

`docs/adr/0002-database.md` has the full proof. The one thing worth restating here: GSI4 is `KEYS_ONLY`, the same choice GSI1/GSI3 both make, but it has a real consequence for this task specifically that the plan's own step 2 describes loosely. The plan says the sweep's query "narrows by `gsi4sk` to the next hour's window and a `FilterExpression` (`attribute_not_exists(reminder_sent_at)`) excludes already-reminded rows." Read literally, that is not possible: `reminder_sent_at` is not an attribute GSI4 projects, and a DynamoDB `FilterExpression` against a GSI can only see the attributes the index itself stores — naming an unprojected one is not an error, but it can never distinguish one item from another, because the index holds none of them for any item. The actual mechanism (built here, and what the ADR's own ratified text says) is the two-step "index gives candidates, the read confirms them" shape this codebase already established twice — `DynamoCaseloadStore.queryPage` (GSI3, TASK 2.5.3) and `DynamoAppointmentStore.listForClinicianCalendar` (GSI1, TASK 3.4.2's own cancelled-row exclusion): a `Query` for candidate keys, then one `GetItem` per row, then an application-level check (`appointment_status === 'scheduled' && reminder_sent_at === undefined`) before a candidate is ever returned.

## Idempotency: claim, *then* attempt to send — not the other way round

`claimForReminder` is one atomic `UpdateItem` (`SET reminder_sent_at`, conditioned on it being absent *and* the row existing). `reminder-sweep.ts` calls it **before** ever calling `Notifier.send`, and skips silently (never retries, never errors) on a failed claim. This ordering is what makes "running the sweep twice against the same window sends exactly one SMS" true: the second run's claim fails before the send is ever attempted, regardless of whether the first run's send itself succeeded, degraded, or failed every guard — R-01's own "every guard failure still marks `reminder_sent_at`" property holds because the claim, not the send outcome, is what sets it.

## Why a real, DynamoDB-backed spend counter was built here, not the in-memory one every other `Notifier` wiring uses

Every existing caller of `createNotifier` (`assignment-handler.ts`, `clinician-admin-handler.ts`) wires `InMemorySpendCounterStore` and `InMemoryRateLimiter`, and that has always been safe: neither of those handlers' own templates is ever `smsEligible`, so the SMS guard chain is present only to satisfy `NotifierDeps`'s type, never actually reached.

This task is different. `appointmentReminder1Hour` *is* `smsEligible`, and `reminder-sweep-handler.ts` is its first real, scheduled caller — on a `rate(15 minutes)` cadence, where AWS has little reason to keep a Lambda execution environment warm between ticks. An in-memory monthly spend counter would reset on most cold starts, which would not enforce C-02's £5 hard cap at all — the exact "spend theoretical, not real" gap this task's own Cost line names directly ("this task is the one that makes that spend real rather than theoretical").

`DynamoSpendCounterStore` (`dynamo-sms-spend-cap.ts`, new) is the fix: an atomic `UpdateItem` (`SET spentPence = if_not_exists(spentPence, :zero) + :amount`, conditioned on the pre-update total against `capPence - amountPence`), keyed `SMS_SPEND#<monthKey>` / `COUNTER`, durable across cold starts the same way `dynamo-audit-log.ts`/`dynamo-notification-log.ts` made their own logs durable at the point each first had a real caller. `sms-spend-cap.ts`'s own header had already named this exact file before it existed: "a DynamoDB-backed implementation can satisfy [`SpendCounterStore`] identically once the notification service actually sends anything."

The rate limiter stays in-memory, deliberately — `contact-form-handler.ts` already accepts the identical "resets on cold start" limitation for its own real, low-volume traffic, and this sweep's own volume is bounded by real scheduled appointments, not attacker-controlled input. It is a secondary, defence-in-depth control beneath the two guarantees that actually matter here: `reminder_sent_at`'s own atomic claim (never two sends for one appointment) and the real spend cap above (never exceeding £5/month).

## `appointment_status`/`reminder_sent_at`/`gsi4pk`/`gsi4sk` — none of it collides with TASK 3.4.2's cancel

Cancelling an appointment (TASK 3.4.2) never touches `gsi4pk`/`gsi4sk` or `reminder_sent_at` — a cancelled appointment stays a real, findable GSI4 row. The sweep's own exclusion (`appointment_status === 'scheduled'`) is what keeps a cancelled appointment from ever being reminded, the identical division of responsibility TASK 3.4.2's own runbook section already established for GSI1's calendar read.

## The manual step this task leaves for the site owner

`sms-provider.ts`'s own header states the convention: the leased origination identity (a UK long code or sender ID in AWS End User Messaging) is "not a secret; recorded as a `config.ts` constant once it exists." It does not exist yet. Provisioning a real one is a manual, out-of-band AWS console step — business verification, an ongoing leasing fee — the same category of action `CERTIFICATE_ARN`'s own DNS validation and `TURNSTILE_SECRET_PARAMETER_NAME`'s own account signup already are in this codebase: not something CDK can provision, and not something this task does on its own authority.

`config.ts`'s new `SMS_ORIGINATION_IDENTITY` constant is left as an empty string rather than invented. Everything else deploys and runs correctly against that empty value: `sms-provider.ts`'s own `SendTextMessageCommand` call fails (AWS rejects an empty `OriginationIdentity`), `sms.ts` catches it as a `ProviderError`, and `notifications.ts`'s own degrade-to-email path is exactly what R-01's "never silently drop a reminder" already requires for that case — patients keep receiving their reminder by email, on schedule, with the correct spend and delivery records, whether or not SMS is actually wired up yet.

**Your action, when ready to enable real SMS sends:**

1. In AWS End User Messaging (`sms-voice` console, `eu-west-2` or the account's chosen SMS region), lease a UK-capable origination identity — a 10DLC/long-code number or a registered sender ID, per current AWS onboarding requirements at the time.
2. Record its ARN as `config.ts`'s `SMS_ORIGINATION_IDENTITY` constant, replacing the empty string.
3. Narrow `infra/src/data-stack.ts`'s `SendReminderSms` IAM statement's `resources` from `['*']` to the leased identity's own ARN — the statement's own comment names this as the follow-up.
4. Redeploy; the next `rate(15 minutes)` tick picks up the new identity with no other change.
5. Turn on `appointments.reminders.enabled` (SSM) only once satisfied with a test send — the flag is independent of `appointments.enabled` (D-11) specifically so scheduling and reminding can be verified separately.

## What was built

- **`docs/adr/0002-database.md`** — GSI4's proof, added before the index itself.
- **`packages/shared-types/src/appointment.ts`** — `Appointment.reminder_sent_at?: string`.
- **`services/api/src/appointment-repository.ts`** — `AppointmentStore.listReminderCandidates`/`claimForReminder`; the matching `AppointmentRepository` methods, deliberately without a `can()`/`ActorContext` gate (there is no principal to authorise against — see below).
- **`services/api/src/dynamo-store.ts`** — `DynamoAppointmentStore.create` now sparsely derives `gsi4pk`/`gsi4sk` (`scheduledAt > created_at` at write time); `listReminderCandidates` (GSI4 `Query` + per-row `GetItem`, with the inclusive-upper-bound millisecond adjustment its own doc explains); `claimForReminder` (atomic `UpdateItem`).
- **`services/api/src/dynamo-sms-spend-cap.ts`** (new) — `DynamoSpendCounterStore`, described above.
- **`services/api/src/reminder-sweep.ts`** (new) — `runReminderSweep`, the orchestration: list candidates, claim, send, described above.
- **`services/api/src/reminder-sweep-handler.ts`** (new) — the deployed Lambda entry, `ScheduledHandler`-typed (not an API Gateway handler — this Lambda has no HTTP route).
- **`services/api/src/flags.ts`** — `appointments.reminders.enabled`, default off, independent of `appointments.enabled` (D-11).
- **`infra/src/data-stack.ts`** — GSI4 (`KEYS_ONLY`, sparse); `ReminderSweepFunction`, its own least-privilege role (`GetItem`/`UpdateItem` on `PAT#*`, `Query` on GSI4 alone, `PutItem` on `NOTIFICATION#*`, `UpdateItem` on `SMS_SPEND#*`, `ses:SendEmail`, `sms-voice:SendTextMessage` — deliberately resource-unscoped for now, see above); an `AWS::Events::Rule` on `rate(15 minutes)`.
- **`infra/src/config.ts`** — `SMS_ORIGINATION_IDENTITY` (empty, pending manual provisioning); `/ndn/reminder-sweep-function` → `UNMONITORED_LOG_GROUP_NAMES`.

### No `can()`/`audit.ts` row for this flow, by design

Every other repository method in this codebase takes a caller-supplied `ActorContext` and writes an `audit.ts` row naming who did what. `listReminderCandidates`/`claimForReminder` don't: they're invoked from an EventBridge schedule with no principal, no HTTP request, nothing for `can()` to authorise or `audit.ts`'s log to attribute an action to. `notification-log.ts`'s own delivery record — written by the `Notifier` for every claimed appointment, on every branch, success or not — is this flow's durable record instead. `reminder-sweep-handler.ts` still constructs a real `AuditWriter` (its `AppointmentRepository`/`PatientRepository` constructors require one), but its own IAM role deliberately carries no `AUDIT#*` write grant — the identical "grant matches what the code can reach, not what the type merely requires" discipline `assignmentRole`'s own read-only `ReadClinicianAccounts` statement already establishes.

## Verification

- `dynamo-sms-spend-cap.test.ts` — the real `UpdateItem` shape (`Key`, `UpdateExpression`, `ConditionExpression` against the pre-update total); a conditional-check failure returns `false`, never a thrown error; independent counters per month key; an unrelated SDK error still propagates.
- `dynamo-store.test.ts` — `create()` derives `gsi4pk`/`gsi4sk` only when `scheduledAt` is after `created_at`, and omits both entirely (not falsy — absent) otherwise; `listReminderCandidates()` issues a real GSI4 `Query` with the inclusive-upper-bound adjustment, excludes a non-`'scheduled'` row and an already-claimed row after the follow-up `GetItem` confirms them, and issues no `GetItem` at all when the `Query` itself finds nothing; `claimForReminder()`'s real `UpdateItem` shape and its `undefined`-not-thrown behaviour on a conditional check failure.
- `appointment-repository.test.ts` — `listReminderCandidates`/`claimForReminder` at the repository layer: window inclusion/exclusion, exclusion of an already-claimed or cancelled appointment, idempotent-replay (`undefined` on a second claim), `undefined` for an appointment that was never scheduled.
- `reminder-sweep.test.ts` — the two named unit tests from this task's own Tests line: an appointment 55 minutes out is included, one 3 hours out is not; running the sweep twice against the same window sends exactly one reminder; a cancelled appointment inside the window is never reminded; nothing happens when the flag is off; the `{time}` var is a plain UK wall-clock string.
- `data-stack.test.ts` — GSI4 exists with the proved key schema and `KEYS_ONLY` projection (now 4 GSIs, not 3); the `AWS::Events::Rule` fires on `rate(15 minutes)` and targets `ReminderSweepFunction`; the `QueryReminderWindowIndex` statement grants `dynamodb:Query` on GSI4 alone; the `ReadAndClaimPatientAppointments` statement grants exactly `GetItem`/`UpdateItem` on `PAT#*`, no `PutItem`; the flag-reading/audit-table function counts and the audit-partition/keyless-read guardrail counts all updated (17 → 18).
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

## What was deliberately not built here

- **A real, leased SMS origination identity.** Named above as the site owner's own manual action — everything else is built and deploys correctly against its absence, degrading every send to email in the meantime.
- **A real DynamoDB-backed rate limiter.** Named above — the in-memory one stays, matching `contact-form-handler.ts`'s own accepted precedent for the identical reason (secondary control, bounded real volume).
- **A cap on how many candidates one sweep tick processes.** No currently reachable failure mode this task's own scope names — a small clinic's own appointment volume is nowhere near the scale where an unbounded per-tick loop would matter — but worth naming as a real scale limit if patient volume ever grows enough to revisit.
- **A live, deployed-provider-sandbox SMS send.** The task's own Tests line names "a real appointment inside the window produces a real SMS to a UK test number" as an integration check against a deployed system with a real origination identity — impossible before that identity exists (above); left as the verification step to run once it does.

## Cost

£0.00 this month at current volume — modelled at $2.00 (M6)/$3.63 (M12) in `03-cost-model.md`, hard-capped at £5 = $6.05 by the real spend counter this task builds. GSI4 adds no new monthly line — sparse write units on `PAT#`/`APPT#` writes only, inside the existing DynamoDB on-demand billing. One more 128 MB arm64 Lambda inside the always-free allowance; the EventBridge rule itself (`rate(15 minutes)`, ~2,880 invocations/month) is inside EventBridge's own always-free tier.
