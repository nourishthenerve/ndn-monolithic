# Appointments, and GSI1's second half: the clinician calendar (TASK 3.4.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.4.1](../plan/05-execution-plan.md) · **Requirements:** §5, FR-VID-04 (the entity video eventually attaches to) · **Decisions:** D-07 · **Depends on:** 3.1.2

## What this covers

`docs/adr/0002-database.md` proved this task's own access pattern before either GSI1 or this entity existed: `gsi1pk = CLI#<clinicianId>` AND `gsi1sk BETWEEN 'APPT#<start>' AND 'APPT#<end>'` — key shape checked while the index was still cheap to shape. GSI1 already carries the clinician→patients projection (TASK 2.5.1) on the identical partition key with a `PAT#` sort-key prefix; this task adds the `APPT#` prefix the ADR reserved, on the same partition — the two patterns never collide even sharing a partition, because each query scopes its own `gsi1sk` prefix.

Three routes: `POST /patients/{id}/appointments` (schedule), `GET /clinicians/me/calendar?from=&to=` (the clinician's own calendar, over GSI1), `GET /patients/{id}/appointments` (a patient's own list, over the main table). No reschedule/cancel — TASK 3.4.2's own scope, "never delete."

## `appointment_status`, not `status` — the same reason `Patient.account_status` exists

The task's own Interfaces sketch names the field `status: 'scheduled' | 'completed' | 'cancelled' | 'no-show'`, colliding with `BaseRecord['status']` — the row-is-live/soft-delete flag every entity in this codebase already carries, whose only two values are `'active'`/`'deleted'`. `packages/shared-types/src/patient.ts`'s own `PatientAccountStatus` comment states the reason precisely: "Deliberately separate from `BaseRecord['status']`... one says whether [the record] may be used, the other says whether the row is live. Collapsing them would make 'cancelled' and 'deleted' the same fact." `Appointment.appointment_status` follows that exact precedent instead of the task's own field name.

## A second real finding, identical to assessment's: only the assigned sub-clinician schedules one

`authz-matrix.ts`'s `Appointments` row: `'Patient (own)'` bare `R`, `'Sub-clinician (assigned)'` `C R U`, `Principal` bare `R`. The task's own step 2 says "an assigned sub-clinician or the principal schedules one" — the matrix disagrees, and (per `00-conventions.md`'s doc-first discipline) the matrix is the authority. Only the assigned sub-clinician ever reaches `create`; the principal, like every other role, may only read. This is the same "whoever is actually delivering care authors it" design `assessment-forms.md`'s own TASK 3.3.1 section already found for assessment forms — the second time this exact class of plan-prose inaccuracy has surfaced this phase, both times in the same direction (over-stating the principal's write access), both times caught by a failing test against the task's own (inaccurate) description rather than assumed correct.

Consequence, identical to `assessment.ts`'s own: the `if (!patient) return 404` branch on the `POST` path is unreachable by construction (no column but `'Sub-clinician (assigned)'` ever reaches `create`, and that column can never resolve without `patient` existing) — kept as defence in depth, documented as such in the code, not removed and not left to look like an accident.

## The composite key, and why GSI1's `KEYS_ONLY` projection needs a follow-up `GetItem`

Main-table key: `PAT#<patientId>` / `APPT#<scheduledAt>`. GSI1 projection: `gsi1pk = CLI#<clinicianId>`, `gsi1sk = APPT#<scheduledAt>` — the identical string as the main-table sort key, derived by one function (`APPOINTMENT_SORT_KEY` in `dynamo-store.ts`) so the two attributes cannot drift apart.

GSI1 is `KEYS_ONLY` (`infra/src/data-stack.ts`, unchanged by this task — "GSI1 already exists"). A `Query` against it therefore returns only key attributes — but that does include the table's own `pk`/`sk`: DynamoDB always projects the base table's primary key into every secondary index, regardless of the index's own projection type, specifically so a follow-up `GetItem` is always possible. `listForClinicianCalendar` uses exactly that: one GSI1 `Query` (never a `Scan`) for the `(pk, sk)` pairs in range, then one `GetItem` per row for the full record — the identical two-step shape `DynamoCaseloadStore.queryPage` + `getPatient` already uses for GSI3, for the identical reason.

## `GET /clinicians/me/calendar` — no `clinicianId` parameter, by construction

The task's own "Do NOT" is explicit: "let the calendar query accept a `clinicianId` parameter a caller could point at someone else." This route has no `{id}`/`{clinicianId}` path segment at all — the resource passed to `can()` names `assignedClinicianId: principal.clinicianId`, the caller's own id, the identical "self-assigned resource" trick `patient.ts`'s own `GET /caseload/mine` uses. A sub-clinician resolves to the already-granted `'Sub-clinician (assigned)'` column against their own id; the principal resolves to `'Principal'` regardless; a patient (no `clinicianId` to self-assign) resolves to `'Patient (other)'` and is denied, with no special-cased rejection branch. There is structurally no parameter through which a caller could name a different clinician's calendar — the query itself is always scoped to `principal.clinicianId`.

## What was built

- **`packages/shared-types/src/appointment.ts`** (new) — `Appointment { patientId, clinicianId, scheduledAt, durationMinutes, appointment_status }`.
- **`services/api/src/appointment-repository.ts`** (new) — `AppointmentRepository`, bespoke (not `Repository<T>`/`VersionedRepository<T>`-based, the same reason `assignment-repository.ts`/`caseload-repository.ts` are: no natural single opaque id, and two genuinely different queries a single-item `KeyValueStore<T>` can't express).
- **`services/api/src/appointment.ts`** (new) — `createAppointmentHandler`: the three routes above, flag-gated (404 off), `can()`-gated (403), Zod-validated (`.strict()`, ISO-datetime), `409` on a same-patient-same-instant double-booking.
- **`services/api/src/appointment-handler.ts`** (new) — the deployed Lambda entry.
- **`services/api/src/dynamo-store.ts`** — `DynamoAppointmentStore`: `create()` (conditional `PutCommand`, GSI1 attributes derived inside the store — the identical "derived inside the store, never a separate input" discipline `DynamoAssignmentStore.writeDecision` established for the `PAT#` pattern), `listForPatient()` (main-table `Query`), `listForClinicianCalendar()` (GSI1 `Query` + per-row `GetItem`, described above).
- **`services/api/src/flags.ts`** — `appointments.enabled`, default off.
- **`infra/src/data-stack.ts`** — `AppointmentFunction`, its own least-privilege role: `GetItem`/`PutItem`/`Query` on `PAT#*` (one statement — the patient lookup, the appointment write, and `listForPatient`'s own main-table query all share the same partition-key-only granularity every other patient-scoped function in this stack accepts), a separate `dynamodb:Query`-only statement on GSI1's own index ARN (the identical shape `patientRole`'s own `QueryOwnCaseloadIndex` statement already uses), `PutItem` on `AUDIT#*`, all guardrailed, and the three new routes.
- **`infra/src/config.ts`** — `/ndn/appointment-function` → `UNMONITORED_LOG_GROUP_NAMES` (bounded by patient count, the same reasoning every prior low-volume clinical function carries).
- **`apps/web/src/account/NextAppointmentPanel.tsx`** (new) — the read-only "next appointment" panel (step 6), added to the patient account page. Unlike TASK 3.3.2's assessment history, this route has an unambiguous data source (`GET /patients/me/appointments`, no per-form id needed), so the frontend extension was buildable without the discovery-mechanism gap `assessment-forms.md` names.

## Verification

- `appointment-repository.test.ts` — 6 tests: `appointment_status` set to `'scheduled'` on create; the audit entry keyed by `<patientId>#<scheduledAt>`; a patient's own list returned chronologically and never leaking another patient's rows; a clinician's calendar returns exactly their own appointments within range, excluding another clinician's same-day appointment and anything outside the range.
- `appointment.test.ts` — 23 tests, including the corrected principal-role case (403, not 201 — the finding above): scheduling for an assigned sub-clinician; `409` on a double-booking; `403` for the principal, an unassigned sub-clinician, and the owning patient; `401`/`404` (flag off); `400` for a non-ISO `scheduledAt`, a missing `durationMinutes`, and a smuggled `clinicianId` field; `403` (not `404`) for the principal against a nonexistent patient id; the patient's own list, its `/me` resolution, and its `403` against a guessed other-patient id; the clinician calendar's own scoping, `403` for a patient, and `400` for a missing `from`/`to`.
- `dynamo-store.test.ts` — a `DynamoAppointmentStore` suite: `create()`'s conditional `PutCommand` with the derived `gsi1pk`/`gsi1sk`; a `ConditionalCheckFailedException` mapped to `AppError('APPOINTMENT_ALREADY_EXISTS')`; `listForPatient()`'s main-table `Query` (asserted to carry no `IndexName`, i.e. never against a GSI, never a `Scan`); `listForClinicianCalendar()`'s GSI1 `Query` with the `BETWEEN` bound followed by the per-row `GetItem`, and the empty-range case issuing no `GetItem` at all.
- `infra/data-stack.test.ts` — all three new routes assert `AuthorizationType: 'CUSTOM'`; the flag-reading/audit-table function counts and the `CUSTOM` route-key list all updated; the audit-partition/keyless-read guardrail counts updated (16 → 17).
- `pnpm --filter @ndn/web build` — the static output still includes an empty `/en/account/patient/index.html`.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

## What was deliberately not built here (as of TASK 3.4.1)

- **Reschedule, cancel, `completed`/`no-show` transitions.** TASK 3.4.2's own scope — "never delete." Built below.
- **A video/call field.** Phase 4's own addition, deliberately deferred so it needs no migration (`05-execution-plan.md`'s own "Do NOT").
- **Gap/collision handling beyond the same-instant `409`.** Two different clinicians double-booking the *same patient* at *overlapping but not identical* times is not checked — the conditional write only catches an exact `scheduledAt` collision. Not a currently reachable failure mode this task's own scope names, but worth naming rather than silently accepting; a real scheduling-conflict check would need to read the patient's existing appointments first, which no step of this task asks for.
- **Pagination on either list.** The same "inherently bounded" reasoning `clinical-record.md`/`patient-record.md`'s own runbook sections already give for a single patient's or clinician's own bounded list.

## Cost (TASK 3.4.1)

£0.00 net-new — GSI1 already exists; this adds write units on `PAT#`/`APPT#` writes only, inside the existing DynamoDB line. One more 128 MB arm64 Lambda inside the always-free allowance.

## TASK 3.4.2 — Reschedule and cancel, never delete

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.4.2](../plan/05-execution-plan.md) · **Requirements:** §5 · **Depends on:** 3.4.1

### What this covers

`POST /patients/{id}/appointments/{apptId}/cancel` transitions `appointment_status` to `'cancelled'`. The row, its `gsi1pk`/`gsi1sk`, and its history all stay exactly as they were — nothing is removed from GSI1 or the main table, matching every other entity in this codebase's own append-only discipline. Rescheduling is **not** an edit to `scheduledAt` on the existing row: it is cancel-the-old, `POST` a new one — the same append-only property `04-data-model-rbac.md` asks of every entity in this table, held here without a special case. `{apptId}` is the appointment's own `scheduledAt` value (URL-encoded by the caller, decoded transparently by API Gateway) — the same "identified by `patientId` + `scheduledAt`, no synthetic id" design TASK 3.4.1 already established.

### Files this task actually touched, vs. its own Files line

The task's own Files line names only `services/api/src/appointment.ts`/`appointment-handler.ts`. In practice, `cancel` needed a new `AppointmentStore` method (`appointment-repository.ts`), a real `UpdateItem` implementation (`dynamo-store.ts`), a `dynamodb:UpdateItem` grant and a fourth route (`infra/src/data-stack.ts`), and this runbook section — the same honestly-noted Files-line omission `clinical-record.md`'s own TASK 3.2.2 section and `assessment-forms.md`'s own TASK 3.3.2 section already name for their respective tasks. `appointment-handler.ts` itself needed no change at all — the same repository/store instances TASK 3.4.1 already wired serve the new method.

### Only the assigned sub-clinician cancels — the identical column `create` reaches

`can(principal, 'update', resource)` gates `cancel`, and `Appointments`'s own matrix row grants `'update'` to the identical single column `'create'` reaches (`'Sub-clinician (assigned)'` only — the same finding TASK 3.4.1's own runbook section already documents for booking). A patient cannot cancel their own appointment through this route, and neither can the principal — both denied for the same reason they never reach booking in the first place. The `if (!patient) return 404` branch is unreachable by construction here too, for the identical reason.

### "Index gives candidates, the read confirms them" — the calendar's own filter, not a second index

Cancelling never touches `gsi1pk`/`gsi1sk`, so a cancelled appointment remains a real, findable GSI1 row. Excluding it from a clinician's *live* calendar is the read's own job: `DynamoAppointmentStore.listForClinicianCalendar`'s per-row `GetItem` follow-up (already necessary because GSI1 is `KEYS_ONLY`) now also checks `appointment_status !== 'cancelled'` before including a row — the identical "index gives candidates, the read confirms them" discipline `DynamoCaseloadStore.queryPage` already uses for its own stale-row case (TASK 2.5.3). `listForPatient` applies no such filter — a patient's own full history is a different question, and shows the real cancelled appointment rather than hiding it.

### What was built

- **`services/api/src/appointment-repository.ts`** — `AppointmentStore.cancel(patientId, scheduledAt, now)`; `AppointmentRepository.cancel`, writing an `'update'` audit row.
- **`services/api/src/appointment.ts`** — `POST /patients/{id}/appointments/{apptId}/cancel`, gated as described above.
- **`services/api/src/dynamo-store.ts`** — `DynamoAppointmentStore.cancel`: an atomic `UpdateItem` (`SET appointment_status = :cancelled, updated_at = :now`, `ConditionExpression: 'attribute_exists(pk)'`, `ReturnValues: 'ALL_NEW'`), a `ConditionalCheckFailedException` mapped to `AppError('RECORD_NOT_FOUND')`. `listForClinicianCalendar`'s cancelled-row filter, described above.
- **`infra/src/data-stack.ts`** — `dynamodb:UpdateItem` added to `AppointmentFunction`'s existing `ReadWriteAndQueryPatientAppointments` statement (already scoped to `PAT#*`, no widening); one new route on the existing integration.

### Verification

- `appointment-repository.test.ts` — 4 new tests: `cancel` transitions `appointment_status` without touching `clinicianId`/`scheduledAt`; a cancelled appointment stays in the patient's own `listForPatient` history; the audit log records both the original `create` and the `update`; cancelling an appointment that was never scheduled throws `AppError('RECORD_NOT_FOUND')` rather than a silent no-op. Plus one addition to the existing `listForClinicianCalendar` suite proving a cancelled appointment is excluded.
- `appointment.test.ts` — 8 new tests: `200` with `appointment_status: 'cancelled'` for an assigned sub-clinician; excluded from the clinician calendar but present (and cancelled) in the patient's own history, in one end-to-end test; `403` for the principal, the owning patient, and an unassigned sub-clinician; `404` (not a silent no-op) for an appointment that was never scheduled; `401`; `404` when the flag is off.
- `dynamo-store.test.ts` — 3 new tests: the real `UpdateCommand` shape (`Key`, `UpdateExpression`, `ConditionExpression`, `ReturnValues`); a `ConditionalCheckFailedException` mapped to `AppError`; a cancelled row still surfacing from the GSI1 `Query` but excluded after the follow-up `GetItem` confirms its status.
- **The "no delete-shaped call" property** the task's own Tests line names is a static one, not a new runtime test: the repo-wide `no-destructive-primitives` eslint rule (TASK 0.3.1) already scans every file in `services/api/src`, `appointment.ts`/`appointment-repository.ts`/`dynamo-store.ts` included, and `pnpm -r lint`'s own green run over this PR is that property held, not merely asserted.
- `infra/data-stack.test.ts` — the new route asserts `AuthorizationType: 'CUSTOM'`; the `CUSTOM` route-key list updated. No function-count changes — `cancel` reuses `AppointmentFunction`, not a new Lambda.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

### What was deliberately not built here

- **A state machine preventing, say, cancelling an already-`completed` appointment.** `cancel`'s own condition is `attribute_exists(pk)` alone — any existing row can be transitioned to `'cancelled'` regardless of its current `appointment_status`. The task's own DoD says "the row survives," not "transitions are validated," and no step asks for one; worth naming as a real, if minor, gap rather than silently accepting it.
- **`completed`/`no-show` transitions.** Named in this task's own Context as a reason the four-state field exists, but no step of TASK 3.4.2 itself builds a route for either — plausibly a later task's scope (a clinician marking attendance), not invented here ahead of being asked for.

### Cost (TASK 3.4.2)

£0.00 net-new — one more route and one widened (still `PAT#*`-scoped) IAM action on the already-deployed `AppointmentFunction`; no new AWS resource of any kind.

## Amendment, 2026-09-01 — the approval step, and the patient's dashboard feed

The owner: *"any new appointment booked by the clinician needs to be approved by the principal clinician"*, and *"when a clinician/principal clinician edits a calender for a given patient it will appear as a notification on patients logged in dashboard."*

### `pending-approval` is a status, not a request entity

A sub-clinician's booking now lands in `appointment_status: 'pending-approval'`, and only `POST …/{apptId}/approve` moves it to `'scheduled'`. `POST …/{apptId}/decline` moves it to `'cancelled'`.

It is a status on the appointment rather than a parallel `APPTREQ#` row because a booking awaiting approval is **already a claim on a slot**: `AppointmentStore.create`'s `attribute_not_exists` conflict has to see it, or two clinicians could each hold a pending booking for the same instant and only discover it at approval time. A separate request entity would carry the same patient, clinician, time and length, and then have to be kept in step with the row it becomes.

A declined request becomes `cancelled` rather than a fifth status: everything that reads this field treats "declined before it was confirmed" and "cancelled after it was" identically — not happening, still in the history, skipped by the clinician calendar — and who decided it and when is already in the audit log.

### Who approves, and who does not need to

`Appointment approval` is its own matrix row, `Principal`-only, and holds `U` alone — there is nothing to create (the appointment exists) and nothing to read that `Appointments`'s own `R` does not already return. It is a distinct row from `Appointments` for the same reason `Patient assignment` is distinct from `Patient profile`: booking a slot and deciding whether that booking stands are two powers, and the whole point of the request is that one role holds the first and a different role holds the second.

**A principal's own booking is `scheduled` immediately.** The approver approving themselves is a step with no decision in it, and one that would either be done reflexively or forgotten — which makes the state mean less, not more.

### The race, and where it is settled

`expect` goes into the `UpdateItem`'s **condition expression**, not into a read before the write. Two principals acting on the same pending request at the same moment produce one transition and one `APPOINTMENT_STATE_CONFLICT` (`409`), never two transitions where the second silently overwrites the first. A failed condition cannot say *which* clause failed, so the row is fetched once on the failure path to tell "no such appointment" from "no longer pending"; the happy path is still one round trip.

`cancel` is deliberately unconditioned and reaches a `pending-approval` row too: a clinician withdrawing a request they have not had approved yet is the same action as calling off a confirmed session, and refusing the first would leave a request nobody could retract.

### Joining a call

`ws-join.ts` already refused anything that was not `'scheduled'`, so a pending booking was denied from the day the status existed. What changed is the *reason*: it now denies `'not-confirmed'` rather than `'cancelled'`. The boundary is identical; telling a clinician their own pending booking was cancelled would have sent them hunting for a cancellation nobody made.

### The dashboard feed

`PAT#<id>` / `NOTIF#<created_at>#<uuid>`, read by `GET /patients/me/notifications` and dismissed by `POST /patients/me/notifications/{notificationId}/read`. Four kinds — requested, approved, cancelled, calendar-updated — written as a side effect of the calendar actions and of a calendar-section write on the assessment form.

Three properties are worth stating because each is a decision rather than a default:

- **The matrix grants `create` on this row to nobody.** A notice is never created by an HTTP call; it is a consequence of an action already authorised on `Appointments` or `Appointment approval`. `C` here would be a second, independently reachable way to put a notice on a patient's dashboard.
- **The record carries no prose** — a kind, a time and an actor id. The sentence a patient reads is rendered from `@ndn/i18n` off the kind, which keeps the feed translatable without a migration and keeps text a patient will read out of a row no clinician authored. A kind the browser has no wording for falls back to a generic line, because the API and the site deploy separately.
- **No audit row, and no `AuditWriter` at all.** An audit row answers "who did what to whom"; a notification is a system-generated echo of an action the repository that performed it has already audited. Auditing the echo would double the log's volume with rows naming the same actor, instant and patient as the row above them. `PatientNotificationRepository` therefore takes no writer — absent, which reads as a decision, rather than passed and ignored, which reads as an oversight — and `audit-wiring.test.ts` names the exemption instead of relaxing its check.
- **Writing a notice never fails the action that caused it.** The appointment is already written by the time the feed is touched, so a failure there is reported as `notified: false` in the response rather than thrown — the same shape `POST /patients` uses for the assessment form it instantiates.

### Marking attendance

`POST …/{apptId}/complete` and `POST …/{apptId}/no-show`, both on the `Appointments` row's existing `update` — the treating clinician's act, and the principal's, not the approver's.

These close a gap TASK 3.4.2 named and left: it explained that `appointment_status` has four values *because* of `completed`/`no-show` and then built no route for either, so the field had never once held `'completed'` anywhere in this system. Harmless until something counted it. Two things now do — the visitor's "number of appointments happened" (`CaseloadRepository`) and the calendar section's "sessions so far" — and both would have read zero forever, which is worse than an obviously missing figure because it looks like a real one.

Both are conditioned on `expect: 'scheduled'`: an appointment that was cancelled, is still awaiting approval, or has already been marked did not take place and cannot be recorded as though it had. Neither writes a dashboard notice — the feed is for what is coming, not for what the patient was already present at.

## Amendment, 2026-09-02 — every booking waits for approval

The first cut exempted the principal: their own bookings were `scheduled` on the spot, on the reasoning that the approver approving themselves is a step with no decision in it.

The owner, on seeing exactly that: *"when I assign an appointment to a patient, it should be visible to patient dashboard to be approved by principal clinician before it appears to patient profile — atm it appears to patient profile right away."*

The exemption was wrong about what the step is for. It is not the principal proving something to themselves — it is the gate that decides **when a booking becomes real to the patient**, and a booking typed in error is caught by the same review whoever typed it. `appointment.ts` no longer reads a role to decide: one status for every new booking, one route out of it.

**The approval controls now sit on the patient's record page**, next to that patient's appointments and directly under the form that creates them. That is the page the dashboard clicks through to, and the page the booking was made on — which is what the owner meant by "visible to patient dashboard to be approved". They remain on the clinician calendar too, where a pending request also appears.

They are rendered for whoever can see a pending row rather than hidden by role. `Appointment approval` is `Principal`-only and the API refuses everyone else, so a clinician looking at their own pending request gets a legible refusal rather than a row with no explanation and no control.
