# The patient's own profile, read and updated for real (TASK 3.1.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.1.1](../plan/05-execution-plan.md) · **Requirements:** §5 (patient record) · **Depends on:** 2.2.3, 2.1.2

## What this covers

`authz-matrix.ts`'s `'Patient profile'` row (`R U (self)` for the owning patient, `C R U` for either clinician role, `R U` for the principal) has stood fully implemented and exhaustively tested since TASK 2.1.1 with no handler ever calling it — TASK 2.2.3 created the `PAT#<id>` / `PROFILE` record and the approval lifecycle on it, and nothing since has ever read or written that record through an HTTP route. This task is that handler: `GET`/`PATCH /patients/{id}`, plus a `/patients/me` self-resolution and the account page it powers.

## The `PATCH` body's shape depends on who is calling — a schema decision, not a wider matrix cell

The matrix's `R U` grants the **action**; it does not say which fields. `person-record.ts`'s clinical/personal split already exists for exactly this distinction: a patient-authored patch accepts `personal{}` only (`fullName`, `phone`, `marketingOptIn`) — never `email`, which stays bound to the Cognito identity that authenticated the request, and never `clinical{}`, which a patient has no basis to author. A clinician-authored patch accepts both halves. Two Zod schemas (`patientOwnPatchBodySchema`, `clinicianPatchBodySchema`), dispatched on `principal.role`, both `.strict()` — an unrecognised key (most pointedly a patient trying to smuggle `clinical` into their own patch) fails the parse with `400` rather than being silently stripped. A caller that tries to write a field it cannot see should learn that, not be quietly ignored.

## A real gap found while building the page, not anticipated in the task's own Interfaces line: `/patients/me`

`apps/web/src/auth/session.ts`'s own header states the design plainly: the access token lives in a closure and is never decoded — `SessionClient` exposes `authorization()` (the raw token string) and nothing else, no claims, no subject id. Building `PatientProfile.tsx` against `GET /patients/{id}` surfaced the consequence directly: **the frontend has no way to know its own patient id** before making the very request that would need it.

Resolved the same way TASK 3.1.2 names its own route `/caseload/mine` rather than expecting a caller to supply their own clinician id: `patient.ts` resolves the literal path segment `'me'` to `principal.patientId` when the caller is a patient principal, before any lookup or `can()` call. No new route was added — `/patients/{id}` already matches the literal string `/patients/me` with `id: 'me'` — and a clinician calling `/patients/me` is denied the same way any malformed relationship is: the literal string `'me'` matches no real patient id, so `can()`'s relationship check (`ownerPatientId === principal.patientId`) fails exactly as it would for a genuinely wrong guess, with no special-cased error path required.

## The leak `audit-read.ts` already named, applied here

"A denied caller must not be able to tell a well-formed request from a malformed one by the shape of the refusal" — `audit-read.ts`'s own rule for its date parameter, applied here to the record's existence. The handler fetches the record **before** calling `can()`, not to skip the check but because the sub-clinician column of this row depends on `assigned_clinician_id`, which only the record itself can answer. `ownerPatientId` passed to `can()` is always the path parameter itself, never derived from whether the record was found — so a patient guessing at another (real) patient's id and a patient guessing at a nonexistent one are both denied with an identical `403`, never a `404` that would leak which is which.

## What was built

- **`services/api/src/patient.ts`** (new) — `createPatientHandler`: `GET /patients/{id}`, `PATCH /patients/{id}`, the `/me` resolution above, flag-gated (404 off), `can()`-gated (403), Zod-validated per caller role (400). Uses `projectFor`/`serialiseResponse` (`projection.ts`) rather than a bare `JSON.stringify` — the discipline `audit-read.ts` already established, and the one this entity is exactly the kind that matters for going forward: `Patient` carries no `private{}` field today, so projection is a no-op in practice and a closed door in the future, the same reasoning `caseload-repository.ts` states for the identical reason.
- **`services/api/src/patient-handler.ts`** (new) — the deployed Lambda entry, wiring `DynamoStore<Patient>` (the generic store, already used identically by `post-confirmation-handler.ts` for the same `PAT#<id>` / `PROFILE` key shape — no new store class).
- **`services/api/src/patient-repository.ts`** — `PatientRepository.update(id, actor, patch)`, new. Field-merges each given sub-object (`personal{}`/`clinical{}`) into the *existing* one rather than calling `Repository.update`'s own shallow merge directly — a patch of `{ personal: { phone } }` must not silently wipe `fullName`/`email`/`marketingOptIn`.
- **`services/api/src/flags.ts`** — `patients.profile.enabled`, default off.
- **`infra/src/data-stack.ts`** — `PatientFunction`, its own least-privilege role (`GetItem`/`PutItem` on `PAT#*`, a separate `PutItem` on `AUDIT#*` for the audit row `PatientRepository.update` writes, both guardrailed), two new routes on the existing `ContentHttpApi`, no `authorizer:` override.
- **`infra/src/config.ts`** — `/ndn/patient-function` → `UNMONITORED_LOG_GROUP_NAMES` (bounded by patient count, same reasoning every prior low-volume admin function in this estate carries).
- **`apps/web/src/account/PatientProfile.tsx`** (new) — the React island: loads via `/patients/me`, renders email read-only, `fullName`/`phone`/`marketingOptIn` as an editable form, saves via `PATCH /patients/me`. Treats a `403` as an ordinary, expected outcome (a signed-in clinician can reach this *page* — `RequireAuth` only knows "signed in" — the server-side `can()` check is the real boundary), matching `CaseloadView.tsx`'s own posture.
- **`apps/web/src/pages/[locale]/account/patient.astro`** (new) — statically generated and empty, `RequireAuth`-gated, same discipline every prior account page states.

## Verification

- `patient-repository.test.ts` — `update()`'s field-merge is exact: a `personal{}` patch never touches `clinical{}` and vice versa; fields the patch never mentioned survive; the audit row names the acting principal; throws for an unknown id; the record stays fully readable and its `account_status`/`status` untouched.
- `patient.test.ts` — 36 assertions: 200 for the owning patient and the principal; 403 for another patient (guessed real id) and for the same guess against a nonexistent id (no distinguishable leak); 403 for an unassigned sub-clinician, 200 for an assigned one; 401 with no principal; 404 when the flag is off; a patient's attempt to smuggle `clinical{}` or change `email` is 400 with the record left untouched; a clinician can patch both halves in one call.
- `infra/data-stack.test.ts` — both routes assert `AuthorizationType: 'CUSTOM'`; the flag-reading/audit-table function counts and the `CUSTOM` route-key list all updated for the new function.
- `pnpm --filter @ndn/web build` — the static output includes an empty `/en/account/patient/index.html`, matching `/en/account/caseload/index.html`'s own shape.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

## What was deliberately not built here

- **Clinician self-service on `'Own profile'`** (the *other*, near-identical matrix row — a clinician editing their own display name, distinct from a patient's `'Patient profile'`). No task names it yet; `authz-matrix.ts`'s own comment already explains a clinician's own profile is modelled as a resource assigned to themselves for `'Own profile'`'s purposes, but no handler for that row exists, and building one is not this task's Files line.
- **A generic `Repository<T>` "patch-merges nested sub-objects" helper.** `PatientRepository.update`'s merge logic is specific to `Patient`'s two named sub-objects (`personal{}`/`clinical{}`); generalising it for every future entity that might want the same behaviour is premature — the next entity that needs it (TASK 3.2.x's diagnosis/care-plan `visible{}`/`private{}` split) has a different enough shape that abstracting now would be guessing at its interface.
- **pr-env axe + keyboard verification against a live authenticated session.** The same honestly-named gap as every prior authenticated page in this codebase: no live-session pr-env testing mechanism exists yet. The page's accessibility is built from semantic HTML (real `<label for>`/`<input>` pairs, `role="status"`/`role="alert"` regions) and verified by construction, not claimed as more than that. **Closed by TASK 5.3.1** ([live-session-accessibility.md](live-session-accessibility.md)): `/en/account/patient` is registered in `account-routes.ts` and axe-scanned in a real, signed-in session on a nightly schedule, against production rather than a per-PR stack.

## Cost (TASK 3.1.1)

£0.00 net-new — one more 128 MB arm64 Lambda inside the always-free allowance; no new AWS resource of any kind.

## TASK 3.1.2 — `GET /caseload/mine`

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.1.2](../plan/05-execution-plan.md) · **Requirements:** §5 (patient record) · **Depends on:** 3.1.1, 2.5.1

### What this covers

A sub-clinician's own caseload, read for real. TASK 2.5.1 built `listPatientIdsForClinician` (GSI1) and deferred its own `dynamodb:Query` IAM grant to "whichever future task first calls it" — this is that task. Lives in `patient.ts` rather than a new file: a small enough extension of the same `'Patient profile'` matrix row that a second file would only be a second place to remember.

Deliberately *not* `GET /caseload` (2.5.3's own path, the principal's cross-caseload view over GSI3) and not a query parameter on it: a sub-clinician's own caseload and the principal's cross-caseload view are different queries against different indexes, and collapsing two differently-scoped reads onto one path is exactly the mistake TASK 2.5.4's own runbook found and reversed for `GET /testimonials`.

### No new matrix row

The resource passed to `can()` names the caller's *own* `clinicianId` as `assignedClinicianId` — the same "modelled as a resource assigned to themselves" trick `authz.ts`'s own comment documents for `'Own profile'`. A sub-clinician resolves to the already-granted `'Sub-clinician (assigned)'` column; the principal resolves to `'Principal'` regardless; a patient (no `clinicianId` to self-assign) resolves to `'Patient (other)'` and is denied — no special-cased "reject patients" branch needed. The GSI1 query itself, keyed on the caller's own `clinicianId` and never a caller-suppliable parameter, is what actually prevents seeing anyone else's caseload — the identical property `GET /caseload` (2.5.3) already has.

A row can fall out of the caseload between the GSI1 read and the follow-up `GetItem` (reassigned, declined) — GSI1 is eventually consistent with the write that produced it, so a stale row is skipped rather than surfaced, the same property `caseload-repository.ts`'s own `listPage` already keeps for GSI3.

### Deliberate scope reduction from this task's own spec

Phase 3's own elaboration (written during TASK 2.5.4's follow-on) said this route should paginate "the same way 2.5.3's `CaseloadRepository` paginates." `listPatientIdsForClinician` (built at 2.5.1) has no cursor/limit support — a single unpaginated `Query`. Left unpaginated on purpose: one clinician's own caseload is inherently bounded in a way the cross-clinic admin view (GSI3, unbounded across every clinician) isn't, so building cursor/limit machinery now would be guessing at a shape no real caseload size has yet demanded. Revisit if a real caseload ever approaches DynamoDB's 1 MB `Query` response cap.

### Response shape, and why plain `JSON.stringify`

Returns `{ items: [{ patientId, fullName }] }` — a plain derived list squeezed out of a `projectFor` call, not a record `ResponseBody`/`serialiseResponse` (`projection.ts`) can carry: `ResponseValue` only accepts scalars and `Projected<T>`/`Projected<T>[]`, not an ad-hoc `{patientId, fullName}` shape. Uses plain `JSON.stringify` instead, matching `caseload.ts`'s own established precedent for the identical situation. The two `/patients/{id}` routes in this same file keep `serialiseResponse`, since a real `Projected<Patient>` flows through them unchanged.

### What was built

- **`services/api/src/patient.ts`** — `GET /caseload/mine`, handled before the `/patients/{id}` path-parameter resolution (this route has none). `PatientDeps` gained `listPatientIdsForClinician: (clinicianId: string) => Promise<string[]>`, injected as a port.
- **`services/api/src/patient-handler.ts`** — wires `DynamoAssignmentStore.listPatientIdsForClinician` directly (not the full `AssignmentRepository`, which also needs a `ClinicianRepository` this route never uses).
- **`infra/src/data-stack.ts`** — `patientRole` gained `QueryOwnCaseloadIndex`, a `dynamodb:Query` grant on the table and GSI1's own index ARN (not `grantReadData()`, which also carries `Scan`) — the same shape `CaseloadFunction`'s own `QueryCaseloadIndex` statement already uses for GSI3. New route `GET /caseload/mine`, reusing the existing `PatientIntegration`.

### Verification

- `patient.test.ts` — 7 new assertions: own caseload hydrated with `fullName`; never returns another clinician's patients even when a stale GSI1 row names them (the skip path); empty list for no caseload; 403 for a patient; a principal's own caseload resolves the same way; 401 with no principal; 404 when the flag is off. 43 tests total in the file, all passing.
- `infra/data-stack.test.ts` — `CUSTOM` route-key list gained `GET /caseload/mine`. 189 infra tests passing.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

### Cost (TASK 3.1.2)

£0.00 net-new — one more route and one more IAM statement on the already-deployed `PatientFunction`; no new AWS resource of any kind.
