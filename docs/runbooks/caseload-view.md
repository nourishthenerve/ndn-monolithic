# Principal clinician's caseload view, and GSI3 (TASK 2.5.3)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.5.3](../plan/05-execution-plan.md) · **Requirements:** FR-DP-02 · **Decisions:** D-07 · **Depends on:** 2.4.1, 2.1.2, 2.5.1

## What this covers

FR-DP-02's cross-caseload admin view — the query `04-data-model-rbac.md` reserved **GSI3** for since 1.3.1, and `09-self-audit.md`'s red-team names as one of the two queries most likely to defeat the single-table design. This task proves that query against the key schema before writing any code (ADR-0002), then builds the index, the read path, and the page.

## Proving the pattern first (step 1)

Recorded in `docs/adr/0002-database.md`'s new "GSI3, proved before code" section: `gsi3pk = 'CASELOAD#all'`, `gsi3sk = CLI#<clinicianId>#PAT#<patientId>` — a `Query` on a fixed partition key, sorted by clinician, `KEYS_ONLY`. One index rather than reusing GSI2's `_all` keyword pattern, because the plan names GSI3 explicitly and patients are the highest-volume entity in the table; folding this into GSI2 would mean every keyword search also scans past every caseload row. No pattern here needs a `Scan`.

## Sparse by construction, not by filtering (steps 2–3)

`gsi3pk`/`gsi3sk` are set in exactly one place: `dynamo-store.ts`'s `DynamoAssignmentStore.writeDecision`, in the same `if (patient.assigned_clinician_id)` branch that already derives GSI1's attributes from the identical field, in the identical transactional write. A patient with no assigned clinician — pending, declined, or reassigned away — simply has no `gsi3pk` attribute, so DynamoDB never projects that row into the index at all. There is no separate "is this row eligible for the admin view" check anywhere downstream, because an ineligible row cannot reach GSI3 in the first place. `KEYS_ONLY` projection: the view only ever needs a patient id to key a follow-up `GetItem` with, so nothing else is worth doubling storage on the table's largest partition for.

## The read path (steps 4–5)

- **`services/api/src/caseload-repository.ts`** (new) — `CaseloadRepository.listPage(principal, cursor, limit)`. Pages `CaseloadStore.queryPage` (GSI3), then `GetItem`s each patient by id. A patient that fell out of the caseload between the index read and this follow-up (GSI3 is eventually consistent with the write that produced it) is skipped rather than surfaced stale — the same "read for real, don't trust the index alone" discipline `AssignmentRepository` already applies. Every patient is passed through `projectFor()` (2.1.2) with the principal's identity, per step 4 — the first place in this codebase the `private{}` boundary is exercised in the *allow* direction rather than the deny direction, even though `Patient` carries no `private{}` field yet (documented in the method's own doc comment, so that stays true by construction the day one is added, not by someone remembering this file). Clinician display names are resolved once per page via a `Map` cache, not once per patient — GSI3's own sort order means several patients routinely share a clinician.
- **`services/api/src/dynamo-store.ts`** — `DynamoCaseloadStore`: `queryPage` issues a `Query` against `GSI3` on the fixed `gsi3pk`, never a `Scan`; cursors are the base64url-encoded `LastEvaluatedKey`, opaque to the caller. `getPatient` is a plain `GetItem` on `PAT#<id>`/`PROFILE`.
- **`services/api/src/caseload.ts`** (new, SDK-free) / **`caseload-handler.ts`** (new, AWS wiring) — `GET /caseload`, following the split every other endpoint in this codebase uses. Flag check (`caseload.view.enabled`) → 404 when off; `requirePrincipal` → 401; `can(principal, 'read', { entityType: 'patient-profile' })` → 403. Reuses the existing **'Patient profile'** matrix row rather than inventing a new one: that row is already `Principal: R U` unconditionally, and every other role is denied by the relationship check failing (this resource carries no `assignedClinicianId`/`ownerPatientId` to match against) — the same row `can()` already evaluates for a single patient read, evaluated here against a resource shape that happens to have no identity of its own. `cursor`/`limit` are read from the query string; an invalid or oversized `limit` is clamped to a default (25) rather than trusted, and the default is used, never a 400, when the value is absent or unparseable — only an invalid *cursor* (one that fails to decode) is rejected with 400.

## The page (step 6)

**`apps/web/src/pages/[locale]/account/caseload.astro`** (new) is statically generated and empty, same discipline as `account/index.astro` and `account/callback.astro`: what makes it private is that no caseload content is ever in the HTML, not server-side gating. It renders `RequireAuth` (2.2.4) around a new React island, **`apps/web/src/account/CaseloadView.tsx`**, which:

- treats a `403` from the API as an ordinary, expected outcome (a signed-in sub-clinician or patient can reach the *page* — `RequireAuth` only knows "signed in", not role — the server-side `can()` check is the real boundary), not an error state;
- holds one page of results at a time, never every page accumulated — matching the backend's own "never accumulate a caseload in memory" (step 5) at the UI layer. Earlier pages are reachable again via a client-side stack of cursors, not by retaining their data;
- is built from semantic HTML rather than ARIA-heavy markup: a real `<table>` with `<caption>` and `scope="col"` headers, loading/error/forbidden states as `role="status"`/`role="alert"` regions, and a `<nav aria-label>` with ordinary `<button>` elements (disabled, not hidden, when there is no next/previous page) for pagination.

Deliberately absent from `routes.ts`, same as the two authenticated-only pages before it — TASK 1.1.3's a11y gate scans every *registered* route unauthenticated, and an authenticated-only page has no accessible content to find that way regardless.

## Log group (step 7)

`/ndn/caseload-function` added to `infra/src/config.ts`'s `UNMONITORED_LOG_GROUP_NAMES`, same as every other function's log group at this stage of the plan.

## IAM (least privilege, matching 2.5.1/2.5.2's own precedent)

`CaseloadFunction` gets a custom-scoped `PolicyStatement` for `dynamodb:Query` on `[table ARN, table ARN + '/index/GSI3']` — explicitly **not** `grantReadData()`, which would also grant `Scan`. Separately, `dynamodb:GetItem` on `PAT#*` (read patient profiles) and `CLI#*` (read clinician display names). No write permissions of any kind — this function has no `write*` method to call one from.

## A CORS bug found and fixed along the way

Building `CaseloadView`'s authenticated `fetch` against `contentApiUrl` surfaced a real, pre-existing production defect: `ContentHttpApi`'s `corsPreflight.allowOrigins` was still `[https://${DOMAIN_NAME}]` — `next.nourishthenerve.com` only — left over from before the G1 cutover to the apex domain, and `allowHeaders` never included `authorization`. Any browser `fetch` from `nourishthenerve.com` or `www.nourishthenerve.com` carrying an `Authorization` header — this task's own caseload requests, but also testimonial submission and workshop checkout, which predate this task — was silently failing CORS preflight from the real production origins. Fixed in `infra/src/data-stack.ts`: `allowOrigins` now lists `SITE_ORIGIN`, `WWW_DOMAIN_NAME`, and `DOMAIN_NAME`; `allowHeaders` now includes `authorization`. Covered by two new tests in `data-stack.test.ts` asserting the exact `AllowOrigins`/`AllowHeaders` synthesised. This is not scope creep on this task — it was found only because this task was the first to add an authenticated cross-origin `fetch` against this API, and left unfixed it would have shipped this feature broken in production for every origin except the one about to be retired.

## Verification

- `caseload-repository.test.ts` — entries carry patient and clinician names; pagination round-trips a cursor and every item appears exactly once across pages (the Tests line's own "never drops or repeats an item"); clinician-name lookups are cached per page, not per patient; a patient that fell out of the caseload between the index read and the follow-up `GetItem` is skipped rather than surfaced stale.
- `dynamo-store.test.ts`'s `DynamoCaseloadStore` cases — `queryPage` issues a `Query` (not a `Scan`) against `GSI3` with the fixed partition key; a cursor round-trips through `ExclusiveStartKey`/`LastEvaluatedKey`; no `nextCursor` on the last page; `getPatient` strips `pk`/`sk` from the returned item. `writeDecision`'s existing tests extended: an approval sets `gsi3pk`/`gsi3sk` alongside `gsi1pk`/`gsi1sk`; a decline sets neither pair.
- `caseload.test.ts` — 200 with items for the principal; 403 for a sub-clinician and for a patient, including with `cursor`/`limit` query parameters attached (there is no clinician-scoping parameter for a sub-clinician to exploit — the Tests line's "cannot reach another clinician's caseload by any parameter" reduces to "there is no parameter", not to a parameter that is checked and rejected); 401 with no principal; 404 when the flag is off; `cursor`/`limit` passed through to the repository; page size defaults to 25, caps at 100, and falls back to the default on an unparseable value.
- `infra/data-stack.test.ts` — GSI3's key schema and `KEYS_ONLY` projection asserted directly (extending the existing GSI test to all three indexes, in synthesis order); the two new CORS tests; updated counts for the new function (audit-table grants, audit-partition/keyless-read denials, flag-reading functions, the `GET /caseload` route under the default/`CUSTOM` authorizer).
- `pnpm --filter @ndn/web typecheck`, `lint`, `test`, and `build` — all clean; the built site includes a static, empty `/en/account/caseload/index.html`, same shape as `/en/account/index.html`.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green.

### "GSI3 returns only rows carrying `gsi3pk`" (Tests line, Integration)

Not independently re-verified against a live table in this test suite — that is what the task's own `Verification` line (`aws dynamodb describe-table`, the deployed endpoint) covers post-deploy, not a unit test. What this suite proves is the half a unit test *can* prove: the write side never sets `gsi3pk`/`gsi3sk` on a patient without `assigned_clinician_id` (`dynamo-store.test.ts`'s decline case). Combined with DynamoDB's own guarantee that a sparse GSI never projects an item missing its key attributes, that write-side proof is what makes the read-side claim true — there is no code path that could put a `gsi3pk`-less row in front of a GSI3 `Query` result for this suite to assert against.

## What was deliberately not built here

- **A sub-clinician-scoped variant of this endpoint.** Step's Tests line asks that such a variant's response "carries no `private{}` field" — no such variant exists, because nothing in this task's own Interfaces or Files describes one (`GET /caseload` is principal-only, full stop), and `Patient` itself carries no `private{}` field yet regardless of who is asking. `CaseloadRepository.listPage` already threads `principal` through `projectFor()` on every read specifically so that the day a `private{}` field and a sub-clinician-facing variant both exist, this file does not need to be revisited to enforce the boundary — it already would.
- **pr-env axe + keyboard verification against a live authenticated session.** The same honestly-named gap as 2.2.4's sign-in flow before it: this codebase's `tests/pr-env/a11y-full.test.ts` scans registered, unauthenticated routes, and no mechanism exists anywhere in this repo yet to drive a real signed-in session against a pr-env deployment. `CaseloadView`'s accessibility is instead built from semantic HTML and verified by construction (table/caption/scope, `role="status"`/`role="alert"` regions, real disabled `<button>`s) and by the backend behaviour tests in `caseload.test.ts` — not a substitute for a live keyboard/axe pass, and this runbook says so rather than implying one happened. **Closed by TASK 5.3.1** ([live-session-accessibility.md](live-session-accessibility.md)): `/en/account/caseload` is registered in `account-routes.ts` and axe-scanned in a real, signed-in session on a nightly schedule, against production rather than a per-PR stack.
- **Component-level tests for `CaseloadView.tsx`.** No React Testing Library/jsdom component-test pattern exists anywhere in `apps/web` today — every existing test there is logic-only (`session.test.ts`, `testimonial-form.test.ts`). Introducing one for a single component would be new test infrastructure this task's Files line doesn't ask for; the component's behaviour (403 handling, pagination, empty/error/loading states) is instead covered indirectly through `caseload.test.ts`'s handler-level assertions of every response shape the component branches on.

## Cost

£0.00 net-new, as planned — GSI3's write units land on writes that already happen (`writeDecision`), inside `03-cost-model.md`'s existing DynamoDB line; one more 128 MB arm64 Lambda inside the always-free allowance.

---

## Amendment, 2026-08-31 — this became the principal's patient dashboard

**Trigger:** the owner, after signing in as the principal clinician for the first time: *"I want … an overall dashboard showing how many patients are there in the system with active ones being at the top. which clinicians each patient has been assigned to with having the option to reassign to a new clinician."*

Everything above still describes the page's authorisation posture, its cursor discipline and its markup accurately. Three things it describes are now wrong, and this section — not an edit in place — is where they are corrected.

### 1. GSI3 is no longer sparse (supersedes "Sparse by construction, not by filtering")

The section above is the exact reason the request could not be served: a `pending` patient — the one the principal opens this page to assign — carried no `gsi3pk`, so no query could reach them. Sparseness was doing a job (keeping the index to "rows that belong in an admin view"), and the job turned out to be the wrong one: **every** patient belongs in an admin view; what differs is what the principal should do about them.

`patientDirectoryIndexAttributes` (exported from `dynamo-store.ts`) now derives `gsi3pk`/`gsi3sk` for every patient, and `gsi3sk` leads with a status rank — `0` approved, `1` pending, `2` suspended, `3` declined — so "active ones at the top" is DynamoDB's own index order across every page, with nothing sorted on the read side. The clinician segment is `UNASSIGNED` where a clinician id would be. The `#PAT#` marker is untouched, so `queryPage`'s parse is unchanged. GSI1 stays sparse: it answers "which patients are mine", which an unassigned patient has no answer to.

Three call sites write a patient `PROFILE` row, and all three must derive the same projection, so `createPatientProfileStore(tableName)` now owns the key shape *and* the projection together — the seven handlers that each repeated `PAT#<id>`/`PROFILE` by hand go through it, and `withoutTableKeys` strips every GSI attribute on read so a stale one cannot be round-tripped back in. (Before this, `PatientRepository.update` only kept the index alive *by accident*, because the attributes were never stripped and so happened to be re-written.)

### 2. Counts

`listPage` asks the store for `{ total, active }` on the **first page only** — a count is a fact about the directory, not the page, and re-counting on every page turn would be two Queries to repeat something already shown. `DynamoCaseloadStore.count` is two `Select: 'COUNT'` Queries over the same GSI3 partition, the second with `begins_with(gsi3sk, '0#')`. No counter attribute, nothing to drift.

### 3. Assign and reassign in place

Each row carries a `<select>` of active colleagues (`GET /clinicians`, new the same day) and one button. The component picks `POST /patients/{id}/approve` for an unassigned patient and `POST /patients/{id}/reassign` for an assigned one — a fact about the patient's status, not a question worth asking the principal; the API rejects the wrong one with 409 (`ALREADY_ASSIGNED`/`NOT_ASSIGNED`) regardless, so the server remains the authority. Deactivated colleagues are filtered out of the dropdown because `AssignmentRepository` would reject them with `CLINICIAN_NOT_AVAILABLE`. A successful mutation reloads the current page: approval changes a patient's rank, and therefore their position in the index, so re-reading is the only honest thing to show.

The route stays `/{locale}/account/caseload` — already deployed, already registered for the nightly authenticated axe scan (`account-routes.ts`), already flag-gated. Only its heading and `caseload.*` strings changed, to "Patient dashboard".

### Backfill required — this is a data migration

No index rewrites its own existing rows. Every patient and clinician record written before 2026-08-31 is invisible to the new queries until `scripts/backfill-directory-index.mjs` is run once against the table:

```sh
export AWS_PROFILE=ndn-prod AWS_REGION=eu-west-2
node scripts/backfill-directory-index.mjs --table <table-name>          # dry run
node scripts/backfill-directory-index.mjs --table <table-name> --apply  # write
```

Idempotent (a correct row is skipped), additive (an `UpdateItem` naming only the index attributes — never a `PutItem` that could clobber a concurrent domain-field write, never a delete), and the one sanctioned `Scan` in the repo. Its own header explains why that is not a breach of the no-`Scan` rule: the rule is about request paths, and the rows it needs are precisely the ones no index knows about.

### Verification, amended

- `caseload-repository.test.ts` gains: an unassigned patient appears as a row with no clinician fields rather than being skipped; counts are returned on the first page and not on later ones (asserted both by the response and by spying that `count()` is not even called).
- `dynamo-store.test.ts` gains: the rank prefix and `UNASSIGNED` segment of `patientDirectoryIndexAttributes`, including that `split('#PAT#')` still recovers the id; `count()` issues exactly two `Select: 'COUNT'` Queries and sums every page; `DynamoStore.get` strips every GSI key attribute and `put` re-derives them. `writeDecision`'s decline case is rewritten — GSI1 drops, GSI3 stays.
- `clinician-admin.test.ts` gains the `GET /clinicians` suite (200 for the principal including deactivated colleagues, 403 for a sub-clinician and a patient, 404 behind the flag).
