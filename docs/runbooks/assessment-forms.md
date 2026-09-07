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

The old record was `visible{}` + `private{}` — one boundary. The owner has drawn three, and no arrangement of two rows expresses them, because helpdesk's reach is not a prefix of anyone else's: wider than the patient's on `prescription{}` (named `patient{}` until 2026-09-07), narrower than the clinician's on `private{}`. So the record now has **one property per section, named exactly as `FieldSet` names it**, and `authz-matrix.ts` has four assessment rows instead of two.

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
- **A visitor's calendar section is two derived figures**, `VISITOR_CALENDAR_FIELDS`: the total number of appointments and the next one. Not the stored `schedulingNotes`, not `sessionsCompleted`, not `appointmentsAwaitingApproval`, and not the section's attachments. The template is filtered to match, so the form never renders a label for a value that will not arrive. See `docs/plan/04-data-model-rbac.md`'s second amendment of the same date for why this is a narrowing of the first cut rather than only an addition.
- **A patient may not write the `tag` field** even though they may write the section it lives in. The tag is the entire mechanism bounding a visitor's reach, so the subject of the record must not choose it. Marked `staffOnly` on the template so the form and the API read the rule from one declaration, and written through to `Patient.tag` — which stays the authority — when staff change it.

### The calendar section is derived

"Next appointment", "sessions so far" and "awaiting approval" are facts about `APPT#` rows. They are computed on every read and returned as a separate `calendarSummary`, never merged into a version's stored responses. Two copies would be two answers the first time a write half-succeeded, and the `APPT#` rows are already what the approval workflow, the clinician calendar and the join-call window read. The only writable field in the section is a free-text scheduling note. Keeping the summary out of `items[]` also means the form has nothing derived to accidentally POST back — and a write naming a derived field is a `400`, not a silent drop.

### Attachments

`POST …/attachment-upload-url` mints a presigned `PutObject` URL; the browser `PUT`s the bytes straight to S3; a section patch then records the key. **The three steps are three separate authorisations**, and the key is what ties them together: it is built entirely from server-held values (the authorised patient id, the form id, the authorised section) plus a uuid, and `assessment.ts` refuses to record any key outside that prefix. A leaked upload URL therefore cannot land an object anywhere the record will acknowledge.

`POST …/attachment-download-url` is the read half, and it is **the only way an assessment attachment is ever served**. The `/media/*` CloudFront behaviour hands the media bucket to anyone with the path — right for a workshop poster, indefensible for a clinical recording — and does not reach the `assessments/` prefix. Downloading needs `read` on the section where uploading needs `update`, which is what lets a patient open a scan a clinician attached to their general info without being able to add one to the clinician's section. It is a `POST`, not a `GET`, because an object key names a patient and a section, and a key in a URL is a key in every access log between here and the browser.

**One bug found while writing the tests, worth recording because both halves of it were individually correct.** The filename sanitiser kept `.`, so a file genuinely named `../notes.pdf` sanitised to `..-notes.pdf` — still containing the `..` that the record-side key check refuses. The upload would have been authorised and the attachment could never have appeared on the record, for a reason nothing would explain. The sanitiser now collapses runs of dots, so every key it mints is one the record will accept.

### Instantiation

`POST /patients` instantiates version 1 from the template immediately after writing the patient record — "the form is loaded from the template the moment his account is being created". It is idempotent, and **a failure does not fail the account**: the account is already fully written by that point, throwing would abandon a usable one for a recoverable reason, and the retry would not be clean (the orphan guard would see both a Cognito user and a record and answer `409` forever). The outcome is reported as `assessmentFormCreated` rather than swallowed, and `assessment.ts`'s own write path instantiates lazily for any patient that reaches it without one — which is also how every patient created before this feature gets a form.

### Follow-up, 2026-09-02 — the upload endpoints were on the wrong API

*"That file could not be uploaded. Please try again — i'm getting this for any file."*

**The endpoint did not exist at the address the browser was calling.** Proven rather than reasoned about, with the same probe against both:

```text
POST …/patients/x/assessments/intake-v1/attachment-upload-url  →  404
GET  …/patients/me/notifications                               →  401
```

A real route on that API answers `401`; these answered `404`.

`NdnWebStack` has **its own `HttpApi`**, separate from `NdnDataStack`'s `ContentHttpApi` — and `ContentHttpApi` is what `site-config.ts` calls `contentApiUrl` and what every island in the site fetches from. The upload function had to live in `NdnWebStack` because it needs the media bucket, which is there (moving it the other way is the CloudFormation cycle `MediaUploadFunction`'s own comment describes). Its routes went on that stack's API with it — and nothing pointed the browser at that API.

Both halves were individually correct. Only the pairing was wrong, which is why nothing in the build, the tests or the types could see it.

The fix is the shape `/auth/*` has used since TASK 2.2.4: a CloudFront behaviour proxying a distinctive prefix to that API, so the browser calls it **same-origin**. The paths moved to `/attachments/{id}/{assessmentId}/{upload,download}-url` — a prefix that cannot shadow anything else, with the ids still in the path so the handler's own parameters are unchanged. Same-origin also means no CORS on that hop at all; the browser's subsequent `PUT` still goes to S3, which has its own rule.

**A new test asserts every route on that stack's API has a CloudFront behaviour covering its path**, because this class of mistake is invisible to everything else. It immediately found a third instance: TASK 1.5.1's `POST /workshops/media-upload-url` has been unreachable since it was written, latent only because nothing in `apps/web` ever called it. That now has a behaviour too — an exact path, not `/workshops/*`, which would shadow the static workshop pages.

**Worth naming: the earlier S3 CORS fix (2026-09-01) was real and necessary, and was not what was breaking this.** It was a second, genuine defect on the same path, found first. The request never got far enough to need it.

### Follow-up, 2026-09-02 (later) — two more, further along the same path

With the routes reachable, the browser finally got a presigned URL and hit the next wall, then would have hit one more. **Four independent defects, in series, on one feature.** Each was invisible until the one before it was fixed, because a request that dies at hop one tells you nothing about hop three.

The full path, and what was wrong at each hop:

| Hop | Defect | Found |
| --- | --- | --- |
| 1. Browser → API | Routes on a different `HttpApi` than the one the site calls | 2026-09-02 |
| 2. Browser → S3 (preflight) | Bucket had no CORS rule at all | 2026-09-01 |
| 3. Browser → S3 (connect) | CSP `connect-src` never named the bucket | 2026-09-02 |
| 4. S3 validates the `PUT` | Presigned URL committed to the checksum of an empty body | 2026-09-02 |

**Hop 3** was the reported one: `Refused to connect because it violates the document's Content Security Policy`. A presigned upload is cross-origin *by design* — that is what presigning is for — and the bucket's own CORS rule cannot authorise what CSP has not named. The two `execute-api` origins in that directive are hardcoded because they belong to another stack; the bucket is `NdnWebStack`'s own construct, so its origin is read from it (`bucketRegionalDomainName`, matching the regional host a default-region `S3Client` signs). That also means every ephemeral PR environment names its own bucket rather than inheriting production's.

**Hop 4** had not been reported yet, and would have been next. The URL in the console carried its own evidence:

```text
x-amz-checksum-crc32=AAAAAA%3D%3D&x-amz-sdk-checksum-algorithm=CRC32
```

`AAAAAA==` is base64 of four zero bytes — the CRC32 of the empty string. Since v3.729 the AWS SDK defaults `requestChecksumCalculation` to `'WHEN_SUPPORTED'`, adding a flexible checksum to every `PutObject`. When the request is *presigned*, the body does not exist yet, so the checksum is computed over nothing and signed into the URL as a query parameter. The URL promises S3 the object is empty before the user has chosen a file; whatever is uploaded disagrees, and S3 rejects it. Correctly. Every file, always.

`requestChecksumCalculation: 'WHEN_REQUIRED'` omits it. Confirmed by presigning both ways and reading the query string back, which is also what `presigner-wiring.test.ts` now does — it asserts the SDK behaviour (so the premise is checked, not assumed), asserts both production handlers set the option, and asserts it is finding the handlers it means to guard. `media-upload-handler.ts` had the identical bug; it simply had no caller to reveal it.

**The lesson, stated plainly:** for three rounds on the blog bug and two here, the failure was diagnosed from the outside — a plausible cause identified, fixed, and reported as *the* cause without confirming the request got past it. A `curl` of the endpoint, and a read of the presigned URL's own query string, each took seconds and each named the real defect immediately. **When a request fails, find out how far it got before designing the fix.**

## Amendment, 2026-09-07 — the four sections become four named areas of the patient record

The owner: *"I want the following sections for a patient - 'Patient Details', 'Patient Assessment Form', 'Patient Prescription', and 'Patient Appointments'."* With each one's audience given in the same message, and then: *"for patient it will be Patient Details, Patient Assessment Form, Patient Prescription, Patient Appointments, Patient Account and Patient Testimonial. … other items should be gone now."*

### No permission changed

Read the four stated audiences against the four `Assessment —` rows in `docs/plan/04-data-model-rbac.md` and they match cell for cell, the IIC narrowing on both visitor cells included. What the rework changed is names, page structure and one page's `allowRoles`; `authz.test.ts`'s independent copy of the table needed one row renamed and no cell touched.

### What moved

| Area | `FieldSet` | Changed how |
|---|---|---|
| Patient Details | `general` | retitled |
| Patient Assessment Form | `private` | retitled; **attribute deliberately not renamed** — `projection.ts` keys R-09's runtime boundary off the literal string `private` |
| Patient Prescription | `prescription` | renamed from `patient` *and* retitled |
| Patient Appointments | `calendar` | retitled |

`ASSESSMENT_SECTION_ORDER` now declares the owner's order (Details, Assessment Form, Prescription, Appointments) and the API's `template` response iterates it, so a placement showing several sections cannot order them differently from any other. Where the *areas* sit on a page is the page's own decision, and the two answers already differ: `patient-record.astro` follows the declared order, while a patient's dashboard puts Appointments at the top on the owner's instruction (*"at the top Calender, then Patient Details, Patient Prescriptions, Patient Account, and Patient Testimonial"*).

### One component, several placements

`AssessmentForm` gained three props: `fieldSets` (which sections belong in this placement), `showTitles` (off when the page has written the heading) and `showVersion` (on for the first placement only). A placement whose section the server did not send renders `null` — that is what keeps a "Patient Assessment Form" heading off a helpdesk or patient screen rather than standing over an empty area.

**`fieldSets` is a placement filter and never a permission.** It narrows what the server already chose to send. The page-level `RequireAuth` gates around the headings are a second, weaker thing — they guess a role from an unverified claim, exactly as every nav link in this app does, and they exist only so a heading is not printed above nothing.

**Placements resync through a `window` event** (`ASSESSMENT_SAVED_EVENT`). Astro mounts each `client:only` island as its own React root, so no React context spans them; without the event, two placements hold two copies of `currentVersion`, the first save moves the record past the second, and the second save gets a 409 from a concurrency check meant for two people rather than two halves of one page.

`PatientRecordPanel` gained `half` for the same reason: its identity form belongs under Patient Details and its appointment table under Patient Appointments, with other content between them, so `patient-record.astro` mounts it twice. Two `GET`s of one item, accepted deliberately — an island renders one contiguous subtree, and the alternative was not available.

### Two behaviour changes worth knowing about

- **`patient-record.astro` admits visitors now.** It refused them while the matrix had granted a visitor `R` on `general{}` and `calendar{}` (IIC-tagged) since 2026-09-01, and the dashboard's caseload table had linked visitors straight at it for just as long — so a visitor clicking a patient got "you do not have access" for a record they were allowed to read. The server was always the decision; the page was refusing ahead of it.
- **`PatientRecordPanel` renders the identity fields read-only for a visitor** (`mayEditDetails`). `Patient profile` gives them `R` and not `U`, and a name field whose every save returns 403 is the mistake the approval buttons made before `mayDecide` existed.

### Pages deleted

`account/patient`, `account/appointments` and `account/testimonial` are deleted, not merely unregistered. All three were second renderings of dashboard sections, nothing in the app linked to any of them, and `account/patient` had drifted into showing a patient the three panels the owner cut on 2026-09-06. `account/content` (assigned content) is **kept** — it is not in the owner's six, but it is a capability rather than a duplicate, so removing it would have deleted a feature.

### Still outstanding

The **fields** under each section are still the 2026-09-01 placeholders, and the ones under "Patient Prescription" in particular still read as the intake questions they were written as. The owner's standing promise (*"there will be all kinds of info that I will provided later on"*) is unchanged, and the arrays in `assessment-template.ts` are the whole of what has to change when it arrives.

*(Superseded for one section by the amendment below: Patient Details is no longer a placeholder.)*

## Amendment, 2026-09-07 (second) — the real Patient Details

The owner supplied the intake form itself, as a screenshot of the paper original, for the first of the four sections. `general{}` went from six placeholder fields to thirty-three — the programme tag it already had, plus thirty-two transcribed from the paper form — and the promise the template's header has carried since 2026-09-01 — *"adding the real intake form later is editing the arrays below and nothing else"* — held: no handler, no repository and no page needed a line changed to render it. What did need changing is set out below, and none of it is the field list.

The other three sections are untouched and still placeholders.

### Two fields are computed, not typed

The paper form prints an `Age: ___ yrs` box beside the date of birth and a `BMI: ___ kg/m²` box beside the height and weight. Both are boxes a person fills in on paper and neither may be a box a person fills in here: a typed age is wrong from the patient's next birthday onward, and a typed BMI is wrong the moment a weight is updated and it is not. Both are marked `derived`, which already meant "computed, never stored, and a write naming it is a 400" — the API's half needed no change at all.

**`derived` now has two kinds, and only `AssessmentForm.tsx` knows the difference.** The calendar's figures are facts about `APPT#` rows the browser has never read, so the server computes them and sends them as `calendarSummary`. Age and BMI are arithmetic on answers in their own section, which the browser is already holding — *including the ones typed and not yet saved*, so a corrected weight moves the BMI beside it immediately. A server-computed value could not do that, which is the whole reason the split exists.

This is the one place a field id is written down outside the template. `apps/web` deliberately does not depend on `@ndn/shared-types`, so the form restates the five ids its arithmetic names (`dateOfBirth`, `age`, `heightCm`, `weightKg`, `bmi`) and nothing makes the compiler compare the copies. `assessment-template.test.ts` guards the half that can be guarded: if an id moves or a derived field loses an input, it fails and names the constant block to move with it. A drifted id is a blank box, never a wrong number.

### `fileNumber` is staff-only, like the tag

`staffOnly` had one instance since 2026-09-01 (`tag`) and its reason was authorisation: the tag bounds a visitor's reach, so the subject of the record must not choose it. `fileNumber` — "Hospital / MRN / file no." — is the second, and the first whose reason is not authorisation. It is an identifier the practice assigns, exactly like `account_status`. A patient may write the section and not that field.

### A visitor's Patient Details is four fields

**This is the change to read if you read only one.** The matrix has granted a visitor `R` on `general{}` since 2026-09-01, and while the section held six placeholder fields, "the whole section" was a defensible reading of that cell. The owner's real form is not six placeholders. It carries a national ID / NHS number, a home address, two telephone numbers, an email, a next of kin and their contact number, an insurer and policy number, and a claim reference — and `docs/runbooks/role-model.md` states a visitor's complete reach in a list that ends *"no email, no phone"*. Shipping the form as-is would have made that sentence false on deploy.

Nothing in the owner's instruction asked to widen a partner organisation's access; the instruction was about a form. **The section grew and the audience did not.** So `VISITOR_GENERAL_FIELDS` is the fields a visitor can already read off their own dashboard row — `familyName`, `givenNames`, `preferredName`, `address` — and nothing else, which keeps the two surfaces telling one story exactly as the calendar narrowing does.

Two places enforce it, and they answer different questions:

- `readableTemplate` filters the **labels**, so the form never renders a box for a value that will not arrive — a visitor should not learn that this practice records a claim number.
- The `items[]` projection filters the **answers**. A filtered label list beside an unfiltered `items[]` would be the leak wearing the fix's clothes: the national ID would still be in the JSON, just without a caption.

**The section's attachments go too.** A file filed under Patient Details is now plausibly a scan of an ID document or an insurance certificate; the old six-field section had nothing to attach that was worth withholding. If a visitor should see a patient's documents, that is a decision to take deliberately rather than one to inherit from a field list growing.

### One thing the screenshot changed that is worth flagging

The paper form's "Preferred contact" box offers **Phone / SMS / Email**. The placeholder it replaced offered Email / Phone / **WhatsApp**, and D-29 says WhatsApp is how the practice actually contacts patients. The screenshot is the instruction, so the options are the screenshot's three — flagged here rather than quietly re-added, because the owner is better placed than this runbook to say which is right.

## Amendment, 2026-09-07 (third) — the real Patient Assessment Form, and the template's first structural change

The owner supplied the second of the four sections as photographs of the paper original: the *Comprehensive Neurorehabilitation and Mental Well-Being Assessment*, 15 pages and 45 numbered sections in SOAP order. Sections 2 to 45 are now the `private` section. **Section 1, Patient Demographics, is deliberately not transcribed** — it is the `general` section already, and the instruction said so: *"Exception Personal Demographics"*.

`private{}` went from 4 placeholder fields to 597.

### This one did not fit "editing one array"

The two previous reworks changed no structure, and this runbook and the template header both said so with some satisfaction. This one could not. **Roughly a third of the paper form's sections are grids** — Medication Review is drug × dose × route × frequency × indication × started × physio-relevant effects, and there are about thirty like it — and a template whose values were `string | number | boolean` had exactly two ways to hold one, both bad:

- **one free-text box per table.** Ships in an afternoon, and throws away the columns. Nothing could ever read a drug name or an outcome score back out, and the clinician gets a blank rectangle where the paper form gave them a ruled grid.
- **seven-times-N numbered fields** (`medication1Drug`, `medication2Drug`, …). Keeps the columns, fixes the row count in advance, and turns a 597-field form into a 1,200-field one.

So the model grew a third thing, which is the change to read this amendment for:

- **`type: 'rows'`** on a field, with **`AssessmentColumnDef[]`** declaring its columns. `AssessmentValue` is now `AssessmentRowValue | readonly AssessmentRow[]`, and a row is a flat bag of scalars — **one level, and no table inside a table**, which the paper form does not do either.
- **`group`**, a string on a field, rendered once above the run of fields that names it. Presentation only: nothing authorises, validates or filters on it.

`group` being a string on a flat field list rather than a nesting of the section is what kept a 45-section form from being a refactor. `section.fields` is still one array, so `validateResponses`, `templateField` and the visitor filter are untouched by grouping — the form does it on render, in `groupsOf`.

### A column is policed exactly as a field is

The template is the schema for which fields exist. A grid's `columns` are the schema for which cells exist inside it, and `validateRows` enforces the second half with the same refusals as the first: a row naming an undeclared column is `UNKNOWN_FIELD`, a cell of the wrong type is `INVALID_FIELD_TYPE`, a select column off its options is `INVALID_FIELD_OPTION`. Without that, `rows` would be exactly the arbitrary key/value store on a clinical record that `UNKNOWN_FIELD` exists to prevent, nested one level deeper and unwatched.

A row *missing* a column is fine and is the ordinary case — a half-filled medication line is a real thing a clinician writes.

Two bounds live in the body schema rather than the template, because they are about an untrusted request and not about clinical content: a row is a record of scalars (so a `responses` bag is at most three deep, which is what keeps `projection.ts`'s walk over it total and cheap), and a grid is capped at 100 rows. The cap is not an opinion about how many medications a patient may be on; a `rows` field is the first thing in this API a caller can make arbitrarily long.

### R-09 needed no change, and that is worth stating

`private{}` now carries far more clinical content than it did — a medication list, red-flag screening, psychosocial scores, a working diagnosis. The boundary that withholds it is unchanged: `projection.ts` keys off the literal attribute name `private`, and `stripPrivate`/`containsPrivateField` already walked arrays and plain objects recursively, so rows pass through them without a line changing. The 100% coverage threshold on that file still holds.

### Four places the transcription made a judgement call

Flagged rather than buried, because each is a place the screen deliberately differs from the paper:

1. **Mutually exclusive tick columns became one `select` column.** Functional Limitations (§16) prints Independent / Aid / Assist needed / Unable as four tick boxes per row, and Functional Assessment (§33) prints Independent / Supervision / Assist ×1 / Assist ×2. A row ticked in two of them is not a finding, it is a slip, so each is a single `level` column.
2. **The body chart (§14) is an attachment, not a field.** Three blank body outlines are a drawing; this template has no drawing type and should not grow one for a single use. The section's existing attachment mechanism takes a photo or scan of the marked-up chart, and the fields hold the written conclusions the paper form asks for underneath it.
3. **The three signature lines (§45) are not captured as signatures.** A typed name is an attestation, not a signature. What is recorded is who completed the assessment, their registration number, who countersigned, and the dates. If the practice needs a real signature that is its own decision — an attachment, or a signing step — and not a text box.
4. **Range of Motion (§26) is three grids, not one.** The spine table has one AROM/PROM pair per movement; the limb tables have a left and a right of each. One table with six mostly-empty columns would be a worse record than three that match the page.

### Two ids were kept

`clinicianImpression` and `workingDiagnosis` are the placeholder section's ids, reused where the owner's form asks the same questions (§35 and §37). A template is not history — a stored answer survives whatever the template does — but reusing the id is what puts an existing answer back in the box it was written in rather than beside an empty one.

### Where a field id is written down outside the template

Two places now, both deliberate and both guarded:

- `AssessmentForm.tsx` names five `general` ids for its age and BMI arithmetic (the previous amendment).
- The 200-odd tick-list checkboxes are declared through a `ticks()` helper in the template itself. **It takes explicit `[id, label]` pairs and never derives an id from a label** — a clinical record keys its answers by id, so a generated id would mean a wording change silently orphaning every answer stored under the old one.

`assessment-template.test.ts` holds the grid invariants that are not compile errors: every grid declares columns, column ids are unique within their grid, select columns have options and nothing else does, no grid is `derived` or `staffOnly`, and no group is ever interleaved — that last one is what makes `groupsOf`'s run-based headings correct rather than merely usually correct.

## Amendment, 2026-09-07 (fourth) — Patient Prescription, and auto-save

Three instructions, and the third turned up a data-loss bug that had been sitting in the resync path since the form was first mounted twice.

### Patient Prescription is one grid

The owner: *"for Patient Prescription have a table which is expandable as we go. there will be the following columns - Sno, Medication/Excercise/Comment, Duration, Date."*

So `prescription{}` is a single `type: 'rows'` field, `prescriptionItems`, with those four columns and nothing else — the first section specified as one field. The five placeholders it replaces (`presentingConcerns`, `goals`, `medicalHistorySummary`, `mobilityAids`, `consentToRecordSessions`) are gone from the form; answers already stored under those ids survive on the versions carrying them, which is the template-is-not-history rule.

`Sno` is a number the clinician writes rather than the row's position. A prescription log is a numbered document a practice may renumber, skip, or continue from a previous sheet, and a serial derived from array position could do none of those. The row's position is already announced to assistive tech separately.

### "Expandable as we go" was already true of the assessment form

The owner also asked that the assessment form's tables be expandable. **They already were** — `type: 'rows'`, added in the amendment above, renders an "add a row" button and appends; the read-only rendering is a plain table. Nothing was needed for this beyond declaring the prescription grid the same way. The one thing that *did* change is the ceiling, below.

### A version is one DynamoDB item, and that ceiling is now reachable

`PK = PAT#<patientId>`, `SK = ASSESS#<assessmentId>#v<n>` — one item per version, and DynamoDB items stop at **400 KB**. That was unreachable while every answer was a scalar; 600-odd short strings do not come close. Thirty grids that a clinician has been invited to expand indefinitely is a different proposition.

Left alone, the failure would have been a `ValidationException` from the driver surfacing as a **500 at an unpredictable point** — a clinician losing a consultation's notes to an error that explains nothing. So:

- **`assertVersionFitsOneItem`** (`assessment-repository.ts`) measures the merged version's UTF-8 bytes against `MAX_VERSION_BYTES` (320 KB) and throws `ASSESSMENT_TOO_LARGE`, which the handler maps to a **400**. Not a 413: the *patch* is small, and what does not fit is the record it would produce.
- It is checked **in the repository, not the handler**, because that is where the merged version exists. The handler only ever sees a patch, and a patch is never the problem — what overflows is the carry-forward that assembles the next version from the previous one, which is the line immediately above the check.
- The headroom to 400 KB is deliberate: the real item also carries `pk`, `sk`, the entity type, the version number and the audit stamps.
- `MAX_ROWS` went from 100 to 1000. It is a cheap bound on one request's body — enough to stop an absurd array being walked at all — and is no longer pretending to be the ceiling. A prescription log accumulated over a course of treatment can genuinely pass a hundred rows.

A refused save loses only itself; every earlier version is still there.

### Auto-save, every thirty seconds

The owner: *"while editing Patient Assessment Form, make it auto saved every 30 seconds, both while filling it normally as well as filling it during Video Call."*

**The video-call half needed no code.** `CallScreen` renders the same `AssessmentForm`, mounted for the rest of the page's life rather than while `connected` — a decision taken earlier for a related reason (*"a blip in someone's wifi must not throw away what a clinician was writing"*) — so the timer comes with it. Worth stating because the alternative reading, a second implementation on the call screen, would have been two behaviours to keep in step.

**It applies to every section the placement renders that the caller may write**, not only the assessment form. The instruction named that section and it is the one a clinician spends a consultation in, but the same screen shows Patient Details above it, and a form whose lower half saves itself while the upper half silently does not is a lost edit waiting to be filed as a bug. Auto-save conditional on which heading you are under is not a feature anyone can hold in mind.

Three properties it has deliberately:

- **It sends only what was touched.** Each section goes through the same `handleSave` the button uses, and `responsesToSave` sends the dirty fields alone — so an autosave cannot overwrite a field this person never looked at, and two clinicians working in different sections of one record do not fight.
- **It never runs two at once.** A save re-reads the record on the way out, so an overlapping tick would compute its patch against a version being replaced.
- **It does not retry a conflict.** A 409 means somebody else wrote while this form was open; the section is re-read and its drafts dropped, exactly as the manual button always did. Retrying automatically would mean silently overwriting another clinician's edit to the same field thirty seconds later, which is not something to do to a clinical record without a person deciding to.

### The bug the timer exposed

`load()` cleared **every** draft and set the loading state, and the `ASSESSMENT_SAVED_EVENT` listener called it. So a placement saving *its* section made every other placement of the form on the page throw away whatever was half-typed in *its* sections, and flash "Loading…" while doing it. Latent while every save was a click; guaranteed to happen to somebody every thirty seconds once a timer could fire one.

`load` now takes `{ silent: true }` for the resync path, which does neither — and a successful save clears only the saved section's drafts (`clearDraftsFor`) instead of the whole bag. The unconditional clear is still right for the initial read: the server's copy is the truth and a surviving draft would show an edit that may not have been stored. It was never right for a sibling's save.

`AssessmentForm.autosave.test.tsx` is **its own file on purpose**: installing `vi.useFakeTimers()` leaves `@testing-library`'s polling unable to advance, so every test after it in the same file hangs. Vitest gives each file its own environment, which makes the file boundary the isolation.
