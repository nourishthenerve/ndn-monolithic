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

## What was deliberately not built here

- **Reschedule, cancel, `completed`/`no-show` transitions.** TASK 3.4.2's own scope — "never delete."
- **A video/call field.** Phase 4's own addition, deliberately deferred so it needs no migration (`05-execution-plan.md`'s own "Do NOT").
- **Gap/collision handling beyond the same-instant `409`.** Two different clinicians double-booking the *same patient* at *overlapping but not identical* times is not checked — the conditional write only catches an exact `scheduledAt` collision. Not a currently reachable failure mode this task's own scope names, but worth naming rather than silently accepting; a real scheduling-conflict check would need to read the patient's existing appointments first, which no step of this task asks for.
- **Pagination on either list.** The same "inherently bounded" reasoning `clinical-record.md`/`patient-record.md`'s own runbook sections already give for a single patient's or clinician's own bounded list.

## Cost

£0.00 net-new — GSI1 already exists; this adds write units on `PAT#`/`APPT#` writes only, inside the existing DynamoDB line. One more 128 MB arm64 Lambda inside the always-free allowance.
