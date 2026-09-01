# Assessment forms: the two-row `visible{}`/`private{}` split, for real (TASK 3.3.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.3.1](../plan/05-execution-plan.md) · **Requirements:** §5, R-09 · **Depends on:** 3.2.1

## What this covers

`authz-matrix.ts` has carried `ASSESSMENT_ENTITY_TYPE` and two dedicated matrix rows (`'Assessment — visible{}'`, `'Assessment — private{}'`) since TASK 2.1.1, and `authz.test.ts`'s exhaustive suite has asserted every cell of both since the same task — including the row R-09's own register entry names directly: `'a patient reaches no private assessment field, in any relationship'`. No assessment record has existed for any of that to run against a real handler until now. This task is that entity: `POST /patients/{id}/assessments/{assessmentId}`, creating the next version of a named form (e.g. "initial mobility assessment") a clinician re-administers over time.

## A named form, not a single per-patient timeline — the key shape difference from diagnosis/care-plan

Diagnosis and care plan (TASK 3.2.1) each version one timeline per patient: `PAT#<id>` / `DIAG#v<n>`. An assessment is different — a patient can have several *named* forms (a mobility assessment, a balance assessment, …), each independently versioned: `PAT#<id>` / `ASSESS#<assessmentId>#v<n>`. `assessment-repository.ts`'s `AssessmentRepository` packs `patientId` and `assessmentId` into `VersionedRepository`'s one `id` parameter as `${patientId}#${assessmentId}` (`compositeId`); `DynamoAssessmentStore` (`dynamo-store.ts`) is what unpacks the resulting `${patientId}#${assessmentId}#v${version}` store key back into `pk`/`sk`.

The unpack is unambiguous in both directions regardless of what characters `assessmentId` itself contains: `lastIndexOf('#v')` finds the version marker because it is always the literal suffix nothing follows, and `indexOf('#')` on what remains finds the patient/assessment boundary because a patient id (a Cognito `sub`, a UUID) never contains `#` — the same guarantee `caseload-repository.ts`'s own GSI3 sort-key parsing already relies on. `dynamo-store.test.ts` proves this against a deliberately pathological `assessmentId` that itself contains the substring `#v`.

## A real finding: the task's own prose is wrong about who may write an assessment

TASK 3.3.1's own Context/Steps text says "an assigned sub-clinician or the principal can write the visible half." The matrix disagrees, and the matrix is the authority (`00-conventions.md`'s doc-first discipline: change `04-data-model-rbac.md` first, then transcribe — `authz-matrix.ts`'s own header states this in exactly these words). The actual `'Assessment — visible{}'` row, standing since TASK 2.1.1 and independently re-asserted by `authz.test.ts`'s own transcription:

```text
| Assessment — visible{} | R | — | C R U | — | R |
```

The `Principal` column is bare `R` — **not** `C R U`. Only the assigned sub-clinician may author an assessment; the principal (and everyone else) may only read one. This is a deliberate, sensible design distinct from diagnosis/care-plan: an assessment is administered by whoever is physically running the sitting, not signed off by a supervising principal on their behalf. Caught by two failing tests written against the task's own (inaccurate) prose, then fixed by correcting the tests, not the handler — `can()` was already reading the real matrix correctly; the assumption was wrong, not the code.

One consequence: the `if (!patient) return respond(404, ...)` branch `assessment.ts` carries (mirroring `clinical-record.ts`'s identical-looking line) is **unreachable by construction** here, not merely untested — no column other than `'Sub-clinician (assigned)'` ever reaches `create` on this row, and that column can never resolve without `patient` existing. Kept anyway, as defence in depth against a future widening of that one matrix cell, and documented as such directly in the code rather than left to look like a copy-paste artefact.

## Why `create`/`update` reach only the `visible{}` row, never a second `can()` call for `private{}`

Per the task's own step 4: writing is one action on one record. A `private{}` value arriving in the same `POST` body as `visible{}` is permitted by construction of the request shape (the Zod schema accepts it), not by a second authorisation decision — the two-row split exists for *reading*, where the split actually matters (TASK 3.3.2), not for writing, where there is only one write.

## What was built

- **`packages/shared-types/src/assessment.ts`** (new) — `Assessment { visible: { formType, responses }; private?: { clinicianImpression } }`. Same layering reason `ClinicalRecord` (TASK 3.2.1) declares `version: number` directly rather than importing `VersionedRecord`: shared-types is the base layer, never the reverse.
- **`services/api/src/assessment-repository.ts`** (new) — `AssessmentRepository`, wrapping one `VersionedRepository<Assessment>`, with the `compositeId` packing described above.
- **`services/api/src/assessment.ts`** (new) — `createAssessmentHandler`: `POST /patients/{id}/assessments/{assessmentId}`, flag-gated (404 off), `can()`-gated against the `'Assessment — visible{}'` row specifically (403), Zod-validated (`.strict()`, 400 on an unrecognised key), `409` on a repeat version number for that named form, `201` with the created version projected through `projectFor` on success.
- **`services/api/src/assessment-handler.ts`** (new) — the deployed Lambda entry.
- **`services/api/src/dynamo-store.ts`** — `DynamoAssessmentStore`, implementing `KeyValueStore<Assessment>` with the same atomic `attribute_not_exists(pk)` conditional-write shape `DynamoClinicalRecordStore` uses.
- **`services/api/src/flags.ts`** — `assessments.enabled`, default off.
- **`infra/src/data-stack.ts`** — `AssessmentFunction`, its own least-privilege role (deliberately separate from `ClinicalRecordFunction`'s — this is the one entity with a real two-row matrix split, and a shared role would risk a future policy change on one silently touching the other), `GetItem`/`PutItem` on `PAT#*` plus `PutItem` on `AUDIT#*`, both guardrailed, and the one new route.
- **`infra/src/config.ts`** — `/ndn/assessment-function` → `UNMONITORED_LOG_GROUP_NAMES` (bounded by patient count, the same reasoning every prior low-volume clinical function carries).

## Verification

- `assessment-repository.test.ts` — version 2 of the same named form never mutates version 1; a repeat version number throws `AppError`; two different named forms for the same patient stay fully independent even at the same version number; a version created with no `private` argument stores no `private` key at all; the audit entry's `entityId` is the full three-part composite key (`pat-1#mobility-initial#v1`).
- `assessment.test.ts` — 14 tests, including the corrected principal-role cases above: 201 for an assigned sub-clinician with the private half echoed back; no `private` key when none supplied; version 2 follows version 1 for the same form; two different forms stay independent at the same version number; 409 on a repeat version; **403 for the principal** (not 201 — the finding above); 403 for an unassigned sub-clinician and the owning patient, both before any write; 401; 404 flag-off; 400 for missing `id`/`assessmentId`/`version`/`visible{}` and a smuggled body key; 403 (not 404) for the principal against a nonexistent patient id, since the principal never reaches `create` on this row at all.
- `dynamo-store.test.ts` — a `DynamoAssessmentStore` suite: `PutCommand`/`GetCommand` against the real three-part key, including the pathological-assessment-id case above; a `ConditionalCheckFailedException` mapped to `AppError('VERSION_ALREADY_EXISTS')`.
- `infra/data-stack.test.ts` — the new route asserts `AuthorizationType: 'CUSTOM'`; the flag-reading/audit-table function counts and the `CUSTOM` route-key list all updated for the new function; the audit-partition/keyless-read guardrail counts updated (15 → 16).
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

## What was deliberately not built here (as of TASK 3.3.1)

- **`GET /patients/{id}/assessments/{assessmentId}`.** TASK 3.3.2's own scope — the read half, where the two-row split is actually exercised (`can()` called twice, once per `fieldSet`), plus the account-page history. Built below.
- **A literal type-level compile error for a `can()` call with no `fieldSet`.** The task's own Tests line names one, but `Resource.fieldSet` (`principal.ts`) is genuinely optional at the type level — there is no narrower type this file could construct that would make omitting it a compile error, only `authz.ts`'s own runtime `'missing-field-set'` denial (already covered by `authz.test.ts`). This file's own guarantee is simpler and true by inspection: the one place it builds a `Resource` for this entity type hardcodes `fieldSet: 'visible'`, so there is only one call site to read, not a type constraint to verify.
- **Gap/sequence validation on the client-supplied version number**, and **pagination** — the same accepted, documented limits `clinical-record.md`'s own TASK 3.2.1 section already names for diagnosis/care-plan, unchanged here.

## Cost (TASK 3.3.1)

£0.00 net-new — one more 128 MB arm64 Lambda inside the always-free allowance; `ASSESS#<id>#v<n>` rows are a few hundred bytes each, inside the existing DynamoDB line.

## TASK 3.3.2 — Reading an assessment: visible to the patient, both halves to a clinician

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.3.2](../plan/05-execution-plan.md) · **Requirements:** §5, FR-DP-05, R-09 · **Depends on:** 3.3.1, 3.2.2

### What this covers

The read side of 3.3.1, and the task R-09's own register entry and `09-self-audit.md`'s red-team both point at most directly — the two-row matrix split exists specifically so this read can be proven, not merely typed. TASK 3.2.2 already proved `projectFor` running in the allow direction once, against a single-row entity (diagnosis/care-plan); this proves the mechanism against the two-row shape the matrix actually reserves for the case a leak would matter most.

### A deliberately different code shape from `clinical-record.ts`'s own read handler

TASK 3.2.2's `GET /patients/{id}/diagnosis` fetches the full record and lets `projectFor` strip `private{}` after the fact — correct, and already proven at 100% branch coverage on `projection.ts`. This task's own step 1 asks for something stricter for the entity R-09 names as the highest-consequence one: "the response never carries a private key because the value was never fetched into the response path, not merely stripped from it after."

`assessment.ts`'s `GET` branch reflects this literally. It asks `can()` twice — once per `fieldSet`, never once with a fabricated "give me everything" resource:

1. `can(principal, 'read', { ...resource, fieldSet: 'visible' })` — the gate. Denied → `403` before any version is even listed.
2. `can(principal, 'read', { ...resource, fieldSet: 'private' })` — decides *which object literal to build* for every version, before `projectFor` ever runs. A patient (or anyone denied the private row) gets `{ version, visible }` — an object that never had a `private` key to strip. A clinician role granted both gets `{ version, visible, private }`.

Every object literal still passes through `projectFor` before `respond()`, for two reasons: it satisfies the `Projected<T>` type brand `ResponseValue` requires (the "forgot to project" compile-error discipline this codebase holds everywhere), and for the visible-only shape it is a provable no-op — there is nothing left for `stripPrivate` to find. The mechanism doesn't rely on that no-op for safety (the shape decision already happened), but keeping every response on the same `projectFor` path means there is exactly one place in this codebase where "did this go through the chokepoint" could ever be asked, never a silent per-route exception.

### What was built

- **`services/api/src/assessment.ts`** — `GET /patients/{id}/assessments/{assessmentId}`, described above. `VersionedRepository.listVersions` (added at TASK 3.2.2) serves this the same way it serves diagnosis/care-plan — one method, a second real caller.
- **`services/api/src/assessment-handler.ts`** — unchanged in substance; the same wiring TASK 3.3.1 built already serves the new route.
- **`infra/src/data-stack.ts`** — one new `GET` route on the existing `AssessmentFunction`/`AssessmentIntegration`, no new AWS resource.

### Verification

- `assessment.test.ts` — 9 new assertions, including **the R-09 test, named as such** (the exact test `02-risk-register.md`'s own register entry and `authz.test.ts`'s own test name both call out): a patient's response to a version carrying a clinician impression contains no `"private"` substring and no impression text anywhere in the *raw serialised* response body, not merely the pre-serialisation object — asserted with `expect(response.body).not.toContain(...)`, not a parsed-object check, because a leak through `JSON.stringify` on the wrong value is exactly the class of bug an upstream chokepoint cannot catch if the test only inspects the object. Newest-first ordering with the private half intact for an assigned sub-clinician and the principal; an empty array (not `404`) for a form with no history yet; `403`, never a `200` with a partial body, for a patient reading another patient's assessment by a guessed id; `403` for an unassigned sub-clinician; `401`/`404` (flag off); `404` for the principal against a nonexistent patient id — reachable here, unlike `POST`, because the principal *does* hold unconditional `read` on both assessment rows.
- `infra/data-stack.test.ts` — the new route asserts `AuthorizationType: 'CUSTOM'`; the `CUSTOM` route-key list updated.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

### What was deliberately not built here

- **The account-page assessment history.** The task's own Files line names `apps/web/src/pages/[locale]/account/patient.astro`, but extending it honestly requires knowing *which* `assessmentId`(s) a given patient has — and no task through 3.3.2 builds a "list my assessment forms" endpoint or catalogue for the frontend to discover that from. `PatientProfile.tsx`/`ClinicalRecordTimeline.tsx` (TASK 3.1.1/3.2.2) both had an unambiguous `/patients/me` or `/patients/me/{kind}` target to fetch; this route has no equivalent without a known `assessmentId` in hand. Building a component that takes an `assessmentId` prop with nothing in `patient.astro` to supply one would be speculative, untestable-by-construction UI — worse than not building it. Left as an honestly-named gap rather than forced into the Files line's letter at the expense of its own intent; closed whenever a form-catalogue task exists to drive it.
- **pr-env axe + keyboard verification.** Moot without the page extension above — the same honestly-named gap as every prior authenticated page in this codebase, restated once its actual UI exists.

## Amendment, 2026-09-01 — four sections, four sets of writers

The owner specified the form in full: *"this assessment form will have three sections. 1. General info 2. Specific to the patient 3. Specific to the clinician. The patient will be able to edit his general info only. The helpdesk can only edit specific to the patient section as well as general section. The clinician/principal clinican can edit all the sections."* Then, separately: *"Therefore I think we need one more section along with 1. General info, 2. Specific to the patient, 3. Specific to the clinician for calender."*

### Why `visible{}` had to go, and why `private{}` stayed

The old record was `visible{}` + `private{}` — one boundary. The owner has drawn three, and no arrangement of two rows expresses them, because helpdesk's reach is not a prefix of anyone else's: wider than the patient's on `patient{}`, narrower than the clinician's on `private{}`. So the record now has **one property per section, named exactly as `FieldSet` names it**, and `authz-matrix.ts` has four assessment rows instead of two.

`private{}` keeps its name even though the owner calls it "specific to the clinician". The label lives in `assessment-template.ts`; the *attribute* stays `private` because `projection.ts`'s `stripPrivate`, `containsPrivateField` and `redactPrivateText` all key off that literal name, and those three are R-09's runtime boundary — the thing keeping a clinical note out of a log line and out of an error message. Renaming the attribute to match the phrasing would have unhooked all of it silently, and nothing would have failed until something leaked.

### The carry-forward, which is the whole design

A write is a **section-scoped patch**: the caller names only the sections they are changing, and `AssessmentRepository.applySectionPatch` reads the previous version server-side and lays the patch over it. Every unnamed section is carried forward byte-for-byte.

This is not a convenience. The obvious alternative — "POST the new version you want" — cannot be made safe for a four-writer record: a patient editing their general info would have to send back the clinician's section, which they cannot read and therefore cannot send. Every such API ends up either denying the patient the edit or letting a client round-trip a section it never saw. Here a section a caller cannot read is a section they cannot name, cannot resend, and cannot destroy by omitting.

`can()` is asked **once per section named**, and the write is atomic: any denied section refuses the whole patch, so a patch is never half-applied.

### Concurrency

`baseVersion` is the version the caller read; the server writes `baseVersion + 1` and the store's `attribute_not_exists` refuses a collision. Two staff editing the same form both compute the same next version and the second gets a `409`, rather than silently discarding the first one's section. `baseVersion: 0` means "I saw no form", and is the only value that may instantiate one — used by the lazy path for patients created before this feature existed.

### Two narrowings that are not in the matrix

Both are enforced in `assessment.ts` and named in `docs/plan/04-data-model-rbac.md`, because the matrix has no vocabulary for either:

- **A visitor sees `IIC`-tagged patients only.** `can()` answers "may a visitor read a general section at all"; only the patient record answers "is this one theirs to see". The check is here *as well as* in `caseload-repository.ts` because they are two different reads — a visitor stopped only at the list would still reach a record by guessing an id. A non-matching patient gets the same `404` a nonexistent one does; a `403` would confirm the patient exists.
- **A patient may not write the `tag` field** even though they may write the section it lives in. The tag is the entire mechanism bounding a visitor's reach, so the subject of the record must not choose it. Marked `staffOnly` on the template so the form and the API read the rule from one declaration, and written through to `Patient.tag` — which stays the authority — when staff change it.

### The calendar section is derived

"Next appointment", "sessions so far" and "awaiting approval" are facts about `APPT#` rows. They are computed on every read and returned as a separate `calendarSummary`, never merged into a version's stored responses. Two copies would be two answers the first time a write half-succeeded, and the `APPT#` rows are already what the approval workflow, the clinician calendar and the join-call window read. The only writable field in the section is a free-text scheduling note. Keeping the summary out of `items[]` also means the form has nothing derived to accidentally POST back — and a write naming a derived field is a `400`, not a silent drop.

### Attachments

`POST …/attachment-upload-url` mints a presigned `PutObject` URL; the browser `PUT`s the bytes straight to S3; a section patch then records the key. **The three steps are three separate authorisations**, and the key is what ties them together: it is built entirely from server-held values (the authorised patient id, the form id, the authorised section) plus a uuid, and `assessment.ts` refuses to record any key outside that prefix. A leaked upload URL therefore cannot land an object anywhere the record will acknowledge.

`POST …/attachment-download-url` is the read half, and it is **the only way an assessment attachment is ever served**. The `/media/*` CloudFront behaviour hands the media bucket to anyone with the path — right for a workshop poster, indefensible for a clinical recording — and does not reach the `assessments/` prefix. Downloading needs `read` on the section where uploading needs `update`, which is what lets a patient open a scan a clinician attached to their general info without being able to add one to the clinician's section. It is a `POST`, not a `GET`, because an object key names a patient and a section, and a key in a URL is a key in every access log between here and the browser.

**One bug found while writing the tests, worth recording because both halves of it were individually correct.** The filename sanitiser kept `.`, so a file genuinely named `../notes.pdf` sanitised to `..-notes.pdf` — still containing the `..` that the record-side key check refuses. The upload would have been authorised and the attachment could never have appeared on the record, for a reason nothing would explain. The sanitiser now collapses runs of dots, so every key it mints is one the record will accept.

### Instantiation

`POST /patients` instantiates version 1 from the template immediately after writing the patient record — "the form is loaded from the template the moment his account is being created". It is idempotent, and **a failure does not fail the account**: the account is already fully written by that point, throwing would abandon a usable one for a recoverable reason, and the retry would not be clean (the orphan guard would see both a Cognito user and a record and answer `409` forever). The outcome is reported as `assessmentFormCreated` rather than swallowed, and `assessment.ts`'s own write path instantiates lazily for any patient that reaches it without one — which is also how every patient created before this feature gets a form.
