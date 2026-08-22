# Diagnosis and care plan: versioned, clinician-authored, with private notes (TASK 3.2.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.2.1](../plan/05-execution-plan.md) · **Requirements:** §5, R-09 · **Depends on:** 3.1.1, 2.1.2, 0.3.3

## What this covers

R-09 — a clinician's private notes reaching a patient — is `02-risk-register.md`'s one **Critical**-rated risk, and its mitigation (`projection.ts`, TASK 2.1.2) was built one phase ahead of schedule specifically so the boundary would exist before any real entity carried private content through it. This task is that entity: `POST /patients/{id}/diagnosis` and `POST /patients/{id}/care-plan`, each creating the next version of a versioned, append-only record with a `visible{}` half every operative role may read and an optional `private{}` half only a clinician role may.

Diagnosis and care plan share one file (`clinical-record.ts`), one repository class (`clinical-record-repository.ts`), and one store class (`DynamoClinicalRecordStore`, `dynamo-store.ts`) — `04-data-model-rbac.md` gives them identical matrix cells and an identical versioned key shape, differing only in which sort-key prefix (`DIAG#`/`PLAN#`) a version lands under.

## Who names the next version number

`VersionedRepository` (TASK 0.3.3/2.1.2) has no "what's the latest version" method — `05-execution-plan.md` deliberately assigns that (`listVersions`) to TASK 3.2.2, not this one. Until then, **the caller states which version number it is creating**, the same way an `If-Match` ETag states which revision a client believes it is building on: a clinician revising a diagnosis they just read supplies that version's successor. `VersionedRepository.createVersion`'s own guard turns a stale or duplicate guess into a thrown `VERSION_ALREADY_EXISTS` (mapped to `409` in the handler) rather than a silent overwrite.

This is a deliberate, scoped decision, not a gap found by accident: a client could in principle POST version `5` before versions `1`–`4` exist (nothing here enforces "no gaps"), and no route yet lets a client discover the current latest version before choosing the next one. Both are accepted for this task and closed by TASK 3.2.2's `listVersions`, which gives a client the history it needs to pick correctly.

## Diagnosis/care-plan's `private{}` split is *not* a matrix-row split, unlike assessment's

`04-data-model-rbac.md`'s `'Diagnosis / care plan'` row is a single row: `'Patient (own)'` gets bare `R`, both clinician columns get `C R U`. This is unlike the assessment form (TASK 3.3.1), which gets **two** matrix rows for one entity (`'Assessment — visible{}'` / `'Assessment — private{}'`) so `can()` can be asked the private-half question directly via a `fieldSet` parameter.

Diagnosis/care-plan has no second row to ask. `projection.ts`'s `mayReadPrivate` therefore gates the two groups differently:

- **Assessment** (`ASSESSMENT_SPLIT_ENTITY_TYPES`): asks `can(principal, 'read', { ...resource, fieldSet: 'private' })` — a real second matrix lookup.
- **Diagnosis/care-plan** (`ROLE_GATED_PRIVATE_ENTITY_TYPES`, new in this task): `principal.role !== 'patient' && can(principal, 'read', resource).allowed` — role is the only axis the row itself draws (the patient column's cell is bare `R`, never `C`/`U`; only the two clinician columns carry the write), so role is the correct second axis. `can()` still decides whether the read is allowed **at all** — an unassigned sub-clinician is still denied there — this function only ever narrows an *already-permitted* read down to "with or without the private half."

Getting this wrong the other way (adding `'diagnosis'`/`'care-plan'` to the assessment-style `fieldSet`-keyed check) would have been the exact leak R-09 exists to prevent: `resolveRow` only branches on `fieldSet` for the assessment entity type, so a fabricated `fieldSet: 'private'` on a diagnosis resource would silently collapse into "may you read a diagnosis at all?" — answering **yes** for the owning patient, the same class of bug `projection.test.ts`'s own `'patient-profile'` negative test already guards against for a different entity.

100% branch coverage on `projection.ts` (the file's own CI-enforced bar, `vitest.config.ts`) is held at this commit — the branch is tested now, at the commit that introduces it, via `projectFor` called directly in `projection.test.ts`, not deferred to TASK 3.2.2's first real read route.

## Why a version's write reaches `projectFor` before its own echo

Step 5 of this task: every create response is projected before it is returned, even though the caller is always the version's own author. Two reasons this still matters: (1) an inoperative clinician (e.g. a `deactivated` sub-clinician who somehow still reaches the handler) must not see their own echoed private note back if `can()` would deny them a read — the status gate in `authz.ts` applies uniformly; (2) it is the same discipline every other write handler in this codebase already holds to (`patient.ts`'s own header names "the 'forgot to project' case" directly) — a freshly created record is branded `Unprojected<T>` like any repository read, so the compiler enforces the same call before it can reach `serialiseResponse`.

## Why a real atomic guard was added to the store, not just the application-level check

`VersionedRepository.createVersion` already checks-then-throws (`get` then, if absent, `put`) before this task. That is a real race against two concurrent writers targeting the same version number, which a single-item DynamoDB conditional write closes and an application-level check alone cannot. `DynamoClinicalRecordStore.put` adds `ConditionExpression: 'attribute_not_exists(pk)'` and maps a `ConditionalCheckFailedException` to the identical `AppError('VERSION_ALREADY_EXISTS', …)` the application-level check already throws — the same defence-in-depth shape `DynamoWorkshopCapacityStore` and `DynamoAssignmentStore` already use elsewhere in `dynamo-store.ts`. `clinical-record.ts`'s one `catch` handles either path with a single `409`.

## What was built

- **`packages/shared-types/src/clinical-record.ts`** (new) — `ClinicalRecord { visible: { summary }; private?: { notes } }`. Deliberately does **not** import `VersionedRecord` from `services/api` (that would invert the dependency graph shared-types sits at the base of); `version: number` is declared directly, structurally identical to `VersionedRecord` so `VersionedRepository<ClinicalRecord>` is satisfied without the import.
- **`services/api/src/clinical-record-repository.ts`** (new) — `ClinicalRecordRepository`, a thin wrapper over `VersionedRepository<ClinicalRecord>`, instantiated twice (`kind: 'diagnosis' | 'care-plan'`) against two `DynamoClinicalRecordStore` instances.
- **`services/api/src/clinical-record.ts`** (new) — `createClinicalRecordHandler`: `POST /patients/{id}/diagnosis`, `POST /patients/{id}/care-plan`, flag-gated (404 off), `can()`-gated (403), Zod-validated (`.strict()`, 400 on an unrecognised key), `409` on a repeat version number, `201` with the created version projected through `projectFor` on success.
- **`services/api/src/clinical-record-handler.ts`** (new) — the deployed Lambda entry, wiring `PatientRepository` (for the assignment-relationship lookup only — never a clinical read or write) and two `ClinicalRecordRepository` instances.
- **`services/api/src/dynamo-store.ts`** — `DynamoClinicalRecordStore`, implementing `KeyValueStore<ClinicalRecord>` against `PK = PAT#<id>` / `SK = DIAG#v<n>` or `PLAN#v<n>`, with the atomic conditional write described above.
- **`services/api/src/projection.ts`** — `mayReadPrivate` split into `ASSESSMENT_SPLIT_ENTITY_TYPES` (the existing `fieldSet`-keyed `can()` call) and `ROLE_GATED_PRIVATE_ENTITY_TYPES` (new: `'diagnosis'`, `'care-plan'`), documented above.
- **`services/api/src/flags.ts`** — `clinicalRecords.enabled`, default off, shared by the write half here and the read half TASK 3.2.2 adds.
- **`infra/src/data-stack.ts`** — `ClinicalRecordFunction`, its own role (deliberately separate from `PatientFunction`'s, even though both read `PAT#*` — this function's write half reaches the conditional-`PutItem` path a profile edit never does), `GetItem`/`PutItem` on `PAT#*` plus `PutItem` on `AUDIT#*`, both guardrailed, and the two new routes on the existing `ContentHttpApi`, no `authorizer:` override.
- **`infra/src/config.ts`** — `/ndn/clinical-record-function` → `UNMONITORED_LOG_GROUP_NAMES` (bounded by patient count, the same reasoning `patient-function` already carries).

## Verification

- `clinical-record-repository.test.ts` — version 2 never mutates version 1, both independently readable; a repeat version number throws `AppError` rather than overwriting; a version created with no `private` argument stores no `private` key at all (`Object.prototype.hasOwnProperty` assertion, not an empty-object check); the audit entry names the correct `entityType` per kind (`diagnosis` vs `care-plan`).
- `clinical-record.test.ts` — 15 assertions: 201 for an assigned sub-clinician and the principal, with the private half echoed back to its own author; no `private` key in the response when none was supplied; version 2 follows version 1; a repeat version number is `409`, not a silent overwrite; 403 for an unassigned sub-clinician and for the owning patient, in both cases *before* any write (asserted via the repository directly); 401 with no principal; 404 when the flag is off; 400 for a missing `id`, a missing `version`/`visible{}`, and a smuggled unrecognised body key; 404 for the principal against a nonexistent patient id (safe: the principal already has unrestricted caseload visibility, so this is not an enumeration leak); care-plan kept fully independent of diagnosis.
- `projection.test.ts` — a new suite exercising `projectFor` directly against a `'diagnosis'`/`'care-plan'` resource: private kept for the assigned sub-clinician and the principal (both entity types); stripped for the owning patient; stripped for an unassigned sub-clinician (denied the row entirely, not merely the private half); stripped for an inoperative assigned sub-clinician. `pnpm test:coverage`'s 100%-branch bar on `projection.ts` holds.
- `dynamo-store.test.ts` — a `DynamoClinicalRecordStore` suite (added after this task's PR was first opened, closing a gap the task's own Tests line named but the initial commit missed): a `PutCommand` against a mocked `DynamoDBDocumentClient`, asserting the real `pk`/`sk`/`ConditionExpression` shape for both `diagnosis` and `care-plan`, a `ConditionalCheckFailedException` mapped to `AppError('VERSION_ALREADY_EXISTS')` rather than the raw SDK exception, and a `GetCommand` round-trip.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.
- `infra/data-stack.test.ts` — both new routes assert `AuthorizationType: 'CUSTOM'`; the flag-reading/audit-table function counts and the `CUSTOM` route-key list all updated for the new function; the audit-partition and keyless-read guardrail counts updated (14 → 15).

## What was deliberately not built here (as of TASK 3.2.1)

- **`GET /patients/{id}/diagnosis`, `GET /patients/{id}/care-plan`.** TASK 3.2.2's own scope — the read half, `listVersions`, and the account-page timeline. Built below.
- **A "what's the latest version" lookup.** Named above; closed by 3.2.2's `listVersions`, not invented early here as a shortcut.
- **Gap/sequence validation on the client-supplied version number.** Nothing here rejects a POST for version `5` when versions `1`–`4` don't exist. Not a currently reachable failure mode for a single clinician working through the UI TASK 3.2.2/a future authoring page will build (which will always know the current latest version, once `listVersions` exists) — but worth naming rather than silently accepting.
- **Merging diagnosis and care plan into one record type with a discriminator field.** They are two entities that happen to share a shape (`04-data-model-rbac.md`'s own two key prefixes), not one entity with a type field — `05-execution-plan.md`'s own "Do NOT" for this task.

## Cost (TASK 3.2.1)

£0.00 net-new — one more 128 MB arm64 Lambda inside the always-free allowance; `DIAG#<v>`/`PLAN#<v>` rows are a few hundred bytes each, inside the existing DynamoDB line.

## TASK 3.2.2 — The read half: diagnosis and care plan, visible to a patient, both halves to a clinician

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.2.2](../plan/05-execution-plan.md) · **Requirements:** §5, FR-DP-05, R-09 · **Depends on:** 3.2.1

### What this covers

TASK 3.2.1 built the write side and the record shape; nothing yet let a patient — or a clinician catching up on a colleague's notes — read it back. `GET /patients/{id}/diagnosis` and `GET /patients/{id}/care-plan` return every version, newest first, each individually projected through `projectFor`. This is the first handler in the whole platform where `projectFor` runs in the **allow** direction against a real, populated `private{}` field, rather than the no-op it has been against `Patient`'s empty one: an assigned sub-clinician's or the principal's response carries every version's private half intact; the owning patient's has it stripped from every version, not only the latest.

### Why every version is projected individually, not the array as a whole

`projectAllFor` (`projection.ts`, already existed since TASK 2.1.2 with no caller until now) applies one `mayReadPrivate` decision and maps it across every element — the decision does not vary per version, so this is not a performance concern, but it is a correctness one: a single call against the *array* rather than the *elements* would have to either strip nothing (wrong, if a patient is asking) or reconstruct each element's shape by hand, reopening exactly the "a client-side filter of a fuller payload" anti-pattern `private-field-boundary.md` warns against, this time on the server. Calling the existing, already-100%-covered `projectAllFor` directly means this task adds no new branch to `projection.ts` at all — the read direction was already proven at TASK 2.1.2; this task is the first real caller.

### `VersionedRepository.listVersions` — the "simplest correct implementation" the task's own steps name

`VersionedRepository` had no way to answer "every version for this id" before this task. `listVersions` reads `getVersion(id, 1)`, `getVersion(id, 2)`, … in order, stopping at the first gap — deliberately not a DynamoDB `Query` against a sort-key prefix (which would need `DynamoClinicalRecordStore` to grow a second method beyond `KeyValueStore<T>`'s `get`/`put`, and `VersionedRepository` itself has no notion of "the store also supports range queries"). This is the exact "no-gaps" assumption TASK 3.2.1's own section above already names as an accepted, documented limit of the caller-supplied version number: a version created out of sequence would end this list early rather than skip the gap. Correct for a low-version-count entity — a clinician revises a diagnosis or care plan occasionally, not thousands of times — and the same reasoning the task's own steps state directly.

`versioned-repository.ts` and `clinical-record-repository.ts` were not in this task's own Files line (only `clinical-record.ts`/`clinical-record-handler.ts`/`patient.astro`/this runbook were named), but step 1 explicitly requires adding `listVersions` to `VersionedRepository` — an omission in the plan text's Files line, not a real scope boundary; both files are touched here, the same honestly-noted adjustment this codebase's runbooks make wherever the plan's Files line and Steps text disagree.

### The `/patients/me/{diagnosis,care-plan}` gap TASK 3.1.1 already found once

`clinical-record.ts`'s `POST` routes never needed a `/me` resolution — a patient can never reach `create` on this row. The new `GET` routes are different: the matrix's `'Patient (own)'` cell for `'Diagnosis / care plan'` grants bare `R`, so a patient reading their **own** history is a real, intended case, and the account page has exactly the same problem TASK 3.1.1's own runbook section already named for `/patients/{id}`: `SessionClient` never decodes the access token, so the frontend has no way to know its own patient id. Resolved identically: `clinical-record.ts` now resolves the literal path segment `'me'` to `principal.patientId` for a patient principal, before any lookup or `can()` call — the read routes this task adds are the first ones on this file that actually need it.

### What was built

- **`services/api/src/versioned-repository.ts`** — `VersionedRepository.listVersions(id): Promise<Unprojected<T>[]>`, described above.
- **`services/api/src/clinical-record-repository.ts`** — `ClinicalRecordRepository.listVersions`, a thin delegation to the above.
- **`services/api/src/clinical-record.ts`** — `GET /patients/{id}/diagnosis`, `GET /patients/{id}/care-plan`; the `ROUTES` table now carries an `action: 'create' | 'read'` alongside each route's entity type, and `can()` is called with that action rather than a hard-coded `'create'`. The `/me` resolution above. Response shape `{ items: Projected<ClinicalRecord>[] }`, newest first.
- **`services/api/src/clinical-record-handler.ts`** — unchanged in substance; the same `patients`/`diagnosis`/`carePlan` wiring TASK 3.2.1 built already serves the new routes.
- **`apps/web/src/account/ClinicalRecordTimeline.tsx`** (new) — the read-only timeline, one component instantiated twice (`kind: 'diagnosis' | 'care-plan'`) on `patient.astro`, fetching `/patients/me/{kind}` and rendering exactly what it received — no client-side filtering of a fuller payload.
- **`apps/web/src/pages/[locale]/account/patient.astro`** — two `<ClinicalRecordTimeline>` instances added below `<PatientProfile>`.
- **`packages/i18n/src/locales/en.json`** — `clinicalRecordTimeline.*` keys.
- **`infra/src/data-stack.ts`** — two new `GET` routes on the existing `ClinicalRecordFunction`/`ClinicalRecordIntegration`, no new AWS resource.

### Verification

- `versioned-repository.test.ts` — `listVersions` returns every version oldest first; an id with no versions returns `[]`; a gap (version 3 written with no version 2) stops the list at the gap rather than skipping it; two ids stay independent.
- `clinical-record-repository.test.ts` — `listVersions` delegates correctly, oldest first.
- `clinical-record.test.ts` — 9 new assertions: newest-first ordering with the private half intact for an assigned sub-clinician and the principal; zero occurrences of the string `"private"` at any depth in the owning patient's response body (`private-field-boundary.md`'s own "negative test per endpoint, forever" convention, its first two real entries); an empty array (not a `404`) for a patient with no history yet; `403`, never a `200` with an empty array, for a patient reading another patient's history by a guessed id; `403` for an unassigned sub-clinician; `401`/`404` (flag off); care-plan history kept independent of diagnosis; the `/patients/me/diagnosis` resolution.
- `infra/data-stack.test.ts` — the two new `GET` routes assert `AuthorizationType: 'CUSTOM'`; the `CUSTOM` route-key list updated.
- `pnpm --filter @ndn/web build` — the static output still includes an empty `/en/account/patient/index.html`.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

### What was deliberately not built here

- **pr-env axe + keyboard verification against a live authenticated session.** The same honestly-named gap as every prior authenticated page in this codebase (TASK 3.1.1's own runbook section states it first): no live-session pr-env testing mechanism exists yet. The timeline is built from semantic HTML (a labelled `<section>`, heading levels that continue the page's own h1 → h2 → h3 structure, `role="status"`/`role="alert"` regions matching every other island in this codebase) and verified by construction, not claimed as more than that.
- **Pagination on the version list.** The same "inherently bounded, unlike a cross-caseload view" reasoning TASK 3.1.2's own runbook section gives for `GET /caseload/mine`: one patient's own diagnosis or care-plan history is not the kind of list that grows toward DynamoDB's page-size concerns.

### Cost (TASK 3.2.2)

£0.00 net-new — two more routes on the already-deployed `ClinicalRecordFunction`; no new AWS resource of any kind.
