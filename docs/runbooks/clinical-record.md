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
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.
- `infra/data-stack.test.ts` — both new routes assert `AuthorizationType: 'CUSTOM'`; the flag-reading/audit-table function counts and the `CUSTOM` route-key list all updated for the new function; the audit-partition and keyless-read guardrail counts updated (14 → 15).

## What was deliberately not built here

- **`GET /patients/{id}/diagnosis`, `GET /patients/{id}/care-plan`.** TASK 3.2.2's own scope — the read half, `listVersions`, and the account-page timeline.
- **A "what's the latest version" lookup.** Named above; closed by 3.2.2's `listVersions`, not invented early here as a shortcut.
- **Gap/sequence validation on the client-supplied version number.** Nothing here rejects a POST for version `5` when versions `1`–`4` don't exist. Not a currently reachable failure mode for a single clinician working through the UI TASK 3.2.2/a future authoring page will build (which will always know the current latest version, once `listVersions` exists) — but worth naming rather than silently accepting.
- **Merging diagnosis and care plan into one record type with a discriminator field.** They are two entities that happen to share a shape (`04-data-model-rbac.md`'s own two key prefixes), not one entity with a type field — `05-execution-plan.md`'s own "Do NOT" for this task.

## Cost

£0.00 net-new — one more 128 MB arm64 Lambda inside the always-free allowance; `DIAG#<v>`/`PLAN#<v>` rows are a few hundred bytes each, inside the existing DynamoDB line.
