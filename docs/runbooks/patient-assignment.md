# Patient assignment (TASK 2.5.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.5.1](../plan/05-execution-plan.md) · **Requirements:** §5 (approval and assignment), §7 (GSI1 access patterns) · **Decisions:** D-07 · **Depends on:** 2.2.3, 2.4.1, 2.1.3

## What this covers

The hinge of the whole authorisation model: a patient sits in `pending` until the principal clinician approves them, and from this task onward `assigned_clinician_id` is a real fact about the data rather than a parameter in a unit test. GSI1 (clinician → patients, and — key shape proved now, not built now — the clinician calendar) lands here.

## Settling what the matrix left silent (step 5)

The doc's RBAC table had no row governing "who may approve or decline a patient." Settled explicitly, in both `docs/plan/04-data-model-rbac.md` and `authz-matrix.ts`, as a new **"Patient assignment"** row: `Principal: C R U`, every other column denied — including both `Sub-clinician` columns. Step 5 floats "a sub-clinician may approve only onto themselves, if the matrix allows it at all"; it doesn't. A sub-clinician can never already be the resource's `assignedClinicianId` before the very decision that would make them so — the row denies both `Sub-clinician` columns outright rather than leaving that resolved by accident of relationship-matching, which is the more defensible reading of "settle it against the matrix" than relying on an emergent side effect. `authz.test.ts`'s exhaustive generated suite (every row × column × action) covers the new row the same way it covers every other — no bespoke test was needed for "a patient cannot approve themselves" or "an unassigned sub-clinician is denied": they're rows 211 and onward of that suite now.

## `PatientRepository.transition` lost `approve`/`decline`

Narrowed to `'suspend'` only. Approving or declining now needs an atomic three-way write (`ASSIGNREQ#` row, the patient's `account_status`/`assigned_clinician_id`, GSI1's projection) that `PatientRepository`'s single-item `KeyValueStore` can't express. **Nothing in production ever called `transition(id, 'approve' | 'decline', …)`** — grep confirmed zero call sites before this task — so narrowing the type closes a footgun (a path that would have silently produced "an approved patient nobody is responsible for," exactly the failure step 2 warns against) rather than removing something used.

## What was built

- **`packages/shared-types/src/assignment.ts`** — `AssignmentRequest`, per the task's own interface, `PAT#<id>` / `ASSIGNREQ#<ts>`, append-only: a new decision is always a *new* row, never an edit to a prior one.
- **`services/api/src/assignment-repository.ts`** — `AssignmentRepository.approve`/`decline`, bespoke (not `Repository<T>`-based, same reason `content-repository.ts`/`testimonial-repository.ts` are). Guards: approving requires the target clinician to exist and be `active` (`ClinicianRepository.findById`, TASK 2.4.1's own dependency); both `approve` and `decline` refuse an already-`approved` patient — reassignment is TASK 2.5.2's job ("there is no unassign"), and this task's methods don't shortcut into it. Returns `{ request, patient }` (the patient branded `Unprojected`, TASK 2.1.2's own contract) so a caller never needs a second read to notify.
- **`services/api/src/dynamo-store.ts`** — `DynamoAssignmentStore`: `writeDecision` is one `TransactWriteItems` — the new `ASSIGNREQ#` row (`attribute_not_exists(pk)`) and the patient's `PROFILE` row, together or not at all. `gsi1pk`/`gsi1sk` are derived from `patient.assigned_clinician_id` alone inside the store, never a separate input — the field and the index cannot disagree with each other by construction. `listPatientIdsForClinician` queries GSI1 with `begins_with(gsi1sk, 'PAT#')`.
- **`infra/src/data-stack.ts`** — GSI1 added (`KEYS_ONLY`, sparse); `AssignmentFunction`, scoped to `dynamodb:GetItem`/`PutItem` on `PAT#*`, read-only `GetItem` on `CLI#*` (this function never writes a clinician), write-only `PutItem` on `AUDIT#*`/`NOTIFICATION#*`, `ses:SendEmail`. **No GSI1 `Query` grant** — nothing this function's own routes call reaches `listPatientIdsForClinician`; that grant lands with whichever future task first calls it (2.5.3's caseload view, most likely), following the same least-privilege discipline the audit reader's own role uses.
- **`services/api/src/assignment.ts` / `assignment-handler.ts`** (the latter beyond the task's literal Files list, added for consistency with every other endpoint's SDK-free/AWS-wiring split — `content-authoring.ts`/`-handler.ts`, `clinician-admin.ts`/`-handler.ts`) — `POST /patients/{id}/approve` (body: `{ assignedClinicianId }`), `POST /patients/{id}/decline`. **The second production route on the real Lambda authorizer**, after TASK 2.4.1's clinician-admin routes — `can()` checked once per route, trusted completely (no second, redundant "is this the principal" check restated in the handler).
- **Notifications (step 6):** `patientApproved`/`patientDeclined` templates (`packages/i18n/src/notifications/`), content-free — no diagnosis, no clinician name, the same privacy posture `ses-registration.ts` states for a mailbox that may not be the patient's alone to read. Best-effort: a failed send is logged and never blocks or reverses a decision that is already real and already audited.
- **`packages/shared-types`, `services/api/src/flags.ts`** — `assignment.enabled`, default off, turned on together with `auth.patientRegistration.enabled` per the task's own Flag line.

## Verification

- `authz.test.ts` — 15 new generated cases (5 columns × 3 actions) for the `'Patient assignment'` row, all passing: only Principal × create/read/update allowed, everything else denied.
- `patient-repository.test.ts` — updated for the narrowed `PatientTransition`; every prior approve/decline-specific case re-expressed against `suspend` (the property under test — idempotent replay, readability after a transition, audit attribution — was never approve/decline-specific).
- `assignment-repository.test.ts` — an already-approved patient is refused for both approve and decline (`ALREADY_ASSIGNED`); a non-existent or deactivated target clinician is refused (`CLINICIAN_NOT_AVAILABLE`); a declined patient can be re-approved and both decisions survive in the append-only history; GSI1 (via the in-memory store's own projection map) returns a patient under the assigned clinician and under no other; one audit row per decision, correctly attributed; no method removes a row.
- `dynamo-store.test.ts`'s new `DynamoAssignmentStore` cases — the atomic write's two `TransactItems`, GSI1 attributes present only when assigned, a cancelled transaction surfaces as one `AppError` (the property "a forced failure on any leg leaves the patient pending with no GSI1 row" reduces to at the transport layer: `TransactWriteItems` either applies every item or none).
- `assignment.test.ts` — 403 for a sub-clinician and for a patient (including a patient attempting to approve themselves); 401/404/400/409 paths; the notification is sent on success and its failure doesn't fail the response.
- `infra/data-stack.test.ts` — GSI1's key schema and projection asserted directly; updated counts (12 audit-table-holding functions, 12 audit-partition/keyless-read denials, 11 flag-reading functions); the route-protection test extended to the two new routes.

**Not independently re-tested:** "an unassigned sub-clinician is denied on that patient's every route." Once GSI1/`assigned_clinician_id` are real facts, this is exactly what `authz.test.ts`'s pre-existing exhaustive suite already proves, for every row the matrix knows about — including the Phase-3 rows (Diagnosis/care plan, Appointments, Messages, …) no handler yet exists for. This task makes that coverage *meaningful* rather than aspirational; it doesn't need to duplicate it.

`pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green. `npx markdownlint-cli2` clean on every touched doc.

## What was deliberately not built here

- **Reassignment** (TASK 2.5.2) — an already-approved patient is refused by both `approve` and `decline`, on purpose; changing an existing assignment, with its own append-only history rule, is that task's job.
- **A "list pending patients" read.** Nothing in this task's Files asks for one, and the principal currently identifies a patient to decide on by some other means (their own id, from wherever it's surfaced — out of this task's scope). A queue view is natural future work, not assumed here.
- **The clinician-calendar half of GSI1.** The key shape is proved (ADR-0002) and costs nothing extra to have shaped now; the appointment entity and its reads are TASK 3.4.x's.
- **A GSI1 `Query` IAM grant on `AssignmentFunction`.** The code (`listPatientIdsForClinician`) exists on the repository; no route on this function calls it, so no grant was added for it — least privilege, not an oversight.

## Cost

£0.00 net-new, as planned — GSI1's write units sit inside `03-cost-model.md`'s existing DynamoDB line; one more 128 MB arm64 Lambda inside the always-free allowance.
