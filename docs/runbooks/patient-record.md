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
- **pr-env axe + keyboard verification against a live authenticated session.** The same honestly-named gap as every prior authenticated page in this codebase: no live-session pr-env testing mechanism exists yet. The page's accessibility is built from semantic HTML (real `<label for>`/`<input>` pairs, `role="status"`/`role="alert"` regions) and verified by construction, not claimed as more than that.

## Cost

£0.00 net-new — one more 128 MB arm64 Lambda inside the always-free allowance; no new AWS resource of any kind.
