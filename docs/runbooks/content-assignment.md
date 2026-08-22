# Content assignment: a clinician assigns existing content to a patient (TASK 3.5.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.5.1](../plan/05-execution-plan.md) · **Requirements:** §5, FR-PP-10 (the keyword index this reuses) · **Depends on:** 3.1.1, 1.3.1

## What this covers

`04-data-model-rbac.md`'s key shape for this entity is deliberately minimal: `PAT#<id>` / `CONTENT#<id>`, no payload beyond the link itself. The content *item* (title, body, per-language translations, keywords) already lives in full at `CONTENT#<id>` / `META`, built and public-readable since TASK 1.3.1 — this task is the assignment relationship alone: which already-published content a clinician has pointed a specific patient at.

Two routes: `POST /patients/{id}/content` (a clinician assigns a published content item to a patient) and `GET /patients/{id}/content` (the patient's own hydrated list). No `DELETE` — the matrix's own row has no `D`-shaped action for this entity, matching every other entity in this table's append-only discipline.

## A real finding: the task's own Step 1 names `Repository<ContentAssignment>`, which cannot express this entity's own read

The task's own Step 1 text says: "a thin `Repository<ContentAssignment>` (0.3.3's generic base, not `VersionedRepository`)." `Repository<T>` (`repository.ts`) is single-key CRUD over `KeyValueStore<T>` — `get(id)`/`put(id, record)` — exactly one opaque `id` per record, with no query capability at all. But the task's own Step 3 requires "the patient's own assigned-content list": every `ContentAssignment` a given patient has, which is inherently a one-to-many read, not a single `get(id)`. There is no single opaque id a `ContentAssignment` naturally has in the first place — it is identified by the pair `(patientId, contentId)` — so `Repository<T>`'s single-key interface cannot express this task's own required read no matter what id scheme is chosen.

This is the same shape `appointment-repository.ts`'s own header already documents for `AppointmentStore`/`AssignmentStore`/`CaseloadStore`: "no natural single opaque id, and its access pattern is a query a single-item `KeyValueStore<T>` can't express." `ContentAssignmentRepository` follows the identical precedent — a bespoke `ContentAssignmentStore` interface (`create`, `listForPatient`), not `Repository<T>`. The task's own prose is corrected here rather than followed literally, per `00-conventions.md`'s doc-first discipline: the actual shape of the read requirement is the authority over a suggested base class that cannot support it.

## A second real finding, identical to assessment's/appointments' own: only the assigned sub-clinician assigns content

The task's own Step 2 says "assigned sub-clinician or principal only, per the matrix's `C R U` for both, bare `R` for the patient." `authz-matrix.ts`'s actual `Content assignment` row: `'Patient (own)': ['read']`, `'Sub-clinician (assigned)': ['create', 'read', 'update']`, `Principal: ['read']` — the principal is granted only `read`, not `create`/`update`. This is the third instance this phase of the identical class of plan-prose inaccuracy `assessment-forms.md`'s TASK 3.3.1 section and `appointments.md`'s TASK 3.4.1 section already found and documented, always in the same direction (over-stating the principal's write access), always caught by a test written against the matrix rather than the task's own description.

Consequence, identical to both prior instances: the `if (!patient) return 404` branch on the `POST /patients/{id}/content` path is unreachable by construction (no column but `'Sub-clinician (assigned)'` ever reaches `create`, and that column can never resolve without `patient` existing) — kept as defence in depth, documented as such in the code, not removed.

## Hydration, and why the locale resolution is deliberately minimal

The task's own Step 3 says each list entry is "hydrated from `ContentRepository.findById` (title/excerpt per the caller's locale) rather than returning bare ids." `ContentAssignmentRepository.listForPatient` hydrates from `item.translations.en` directly — `@ndn/i18n`'s `Locale` union has exactly one member today, so "the caller's locale" and "`en`" are the same fact, and there is no second locale yet to resolve between. This deliberately does **not** build new locale-resolution machinery, and does **not** reuse `GET /content`'s own precedent of returning every locale's `translations` object and letting the frontend pick — that precedent exists for a *public*, cacheable list where every visitor's locale is unknown ahead of time; here the server already knows there is exactly one. Revisit this method once a second locale exists and "the caller's locale" becomes a real question rather than a formality.

## What was built

- **`packages/shared-types/src/content-assignment.ts`** (new) — `ContentAssignment { patientId, contentId, assignedAt: string }`, extending `BaseRecord` unchanged (no domain lifecycle beyond active/deleted — there is no `D`-shaped action on this row to name a second status for).
- **`services/api/src/content-assignment-repository.ts`** (new) — `ContentAssignmentStore` (bespoke, per the finding above: `create`, conditioned on not already existing; `listForPatient`, a main-table `Query`) and `ContentAssignmentRepository`, which depends on `ContentRepository` (TASK 1.3.1, reused directly) for the publish-check on `assign` and the title/excerpt hydration on `listForPatient`.
- **`services/api/src/content-assignment.ts`** (new) — `createContentAssignmentHandler`: the two routes above, flag-gated (404 off), `can()`-gated (403), Zod-validated (`.strict()`), `400` for unpublished/nonexistent content, `409` on a duplicate assignment, the `/patients/me/content` resolution `patient.ts`/`clinical-record.ts`/`appointment.ts` already give their own patient routes.
- **`services/api/src/content-assignment-handler.ts`** (new) — the deployed Lambda entry, wiring `DynamoContentAssignmentStore` alongside the existing `DynamoContentStore`.
- **`services/api/src/dynamo-store.ts`** — `DynamoContentAssignmentStore`: `create()` (conditional `PutCommand`, `attribute_not_exists(pk)`, mapped to `AppError('RECORD_ALREADY_EXISTS')` on collision), `listForPatient()` (main-table `Query`, `begins_with(sk, 'CONTENT#')` — never a `Scan`).
- **`services/api/src/flags.ts`** — `contentAssignment.enabled`, default off.
- **`infra/src/data-stack.ts`** — `ContentAssignmentFunction`, its own least-privilege role: `GetItem`/`PutItem`/`Query` on `PAT#*` (the patient lookup, the assignment write, and `listForPatient`'s own query, the same partition-key-only granularity every other patient-scoped function in this stack accepts), a separate `GetItem`-only statement on `CONTENT#*` (the publish-check and the hydration read — never `Query`/`Scan`, both call sites already hold the exact `contentId` they need), `PutItem` on `AUDIT#*`, all guardrailed, and the two new routes.
- **`infra/src/config.ts`** — `/ndn/content-assignment-function` → `UNMONITORED_LOG_GROUP_NAMES` (bounded by patient count, the same reasoning every prior low-volume clinical function in this phase carries).

## What this task's own Files line under-specified

The task's own Files line names `content-assignment.ts`/`content-assignment-repository.ts`/`content-assignment-handler.ts`/`infra/src/data-stack.ts` — it does not separately name `services/api/src/dynamo-store.ts`, which needed the new `DynamoContentAssignmentStore` class, or `infra/src/config.ts`, which needed the new log group name. The same honestly-noted Files-line omission `appointments.md`'s own TASK 3.4.2 section and `clinical-record.md`'s own TASK 3.2.2 section already name for their respective tasks — a task's "Files" line names the surface, not always every file a correct implementation structurally requires.

## Verification

- `content-assignment-repository.test.ts` — 7 tests: assigning published content stamps `assignedAt` to `created_at`; the audit entry is keyed by `<patientId>#<contentId>`; assigning a draft or a nonexistent content id throws `AppError('CONTENT_NOT_PUBLISHED')`; `listForPatient` hydrates title/excerpt from the real content item; never returns another patient's assignments; returns an empty list for a patient with none.
- `content-assignment.test.ts` — 17 tests, including the corrected principal-role case (403, not 201 — the finding above): assigning for an assigned sub-clinician; `409` on a duplicate assignment; `400` for unpublished/nonexistent content; `403` for the principal, an unassigned sub-clinician, and the owning patient; `401`/`404` (flag off); `400` for a missing `contentId` and a smuggled body field; `403` (not `404`) for the principal against a nonexistent patient id; the patient's own hydrated list, its `/me` resolution, and its `403` against a guessed other-patient id.
- `dynamo-store.test.ts` — a `DynamoContentAssignmentStore` suite: `create()`'s conditional `PutCommand`; a `ConditionalCheckFailedException` mapped to `AppError('RECORD_ALREADY_EXISTS')`; `listForPatient()`'s main-table `Query` (asserted to carry no `IndexName`, i.e. never against a GSI, never a `Scan`); the empty-list case.
- `infra/data-stack.test.ts` — both new routes assert `AuthorizationType: 'CUSTOM'`; the flag-reading/audit-table function counts, both guardrail-denial counts, and the `CUSTOM` route-key list all updated (18 → 19); a dedicated `describe('DataStack — content assignment function (TASK 3.5.1)')` block: the `PAT#*` grant (`GetItem`/`PutItem`/`Query`, no `UpdateItem` — this entity is never edited in place), the `CONTENT#*` grant (`GetItem` only), and the audit-partition/keyless-read guardrails.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green (services/api: 1123 tests; infra: 197 tests).
- `node scripts/check-no-disable-comments.mjs` — clean.

## What was deliberately not built here (as of TASK 3.5.1)

- **Un-assigning content.** The matrix's own row has no `D`-shaped action, and the task's own Step 1 says removal is "out of scope for this task" — no route, no store method.
- **The patient's own "my content" account page.** TASK 3.5.2's own scope, per this phase's established "backend task ships its own page, frontend-only follow-up task wires the account shell" split (`caseload.md`'s TASK 2.5.3 and `patient-record.md`'s TASK 3.1.1 already establish the same shape).
- **Multi-locale hydration.** Deliberately deferred — see the "Hydration" section above.
- **Pagination on the list.** The same "inherently bounded by one patient's own assigned-content count" reasoning `clinical-record.md`/`appointments.md`'s own runbook sections already give for a single patient's bounded list.

## Cost (TASK 3.5.1)

£0.00 net-new — `ContentRepository`, GSI2, and every content Lambda already exist from Phase 1; this adds one thin row per assignment on the existing `PAT#`/`CONTENT#` key shape, inside the existing DynamoDB line. One more 128 MB arm64 Lambda inside the always-free allowance.

## TASK 3.5.2 — The patient's "my content" page

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.5.2](../plan/05-execution-plan.md) · **Requirements:** §5 · **Depends on:** 3.5.1

### What this covers

The read side of 3.5.1 exposed via the account shell — the same "backend task ships its own page" shape `caseload-view.md`'s own TASK 2.5.3 section and `patient-record.md`'s own TASK 3.1.1 section already establish, rather than a separate frontend-only task with nothing new to build against. A signed-in patient visiting `/account/content` sees their assigned articles, each linking straight into the existing public blog article page (`/${locale}/blog/{contentId}`, TASK 1.3.2) — no new content-rendering surface, per this task's own "Do NOT."

### What was built

- **`apps/web/src/account/AssignedContent.tsx`** (new) — a React island, the same shape `ClinicalRecordTimeline.tsx`/`CaseloadView.tsx` already establish: fetches `GET /patients/me/content` (the same `/me` resolution `ClinicalRecordTimeline.tsx`'s own header documents — this component has no way to know its own patient id), treats a `403`/`401` as an ordinary "forbidden" state rather than an error (the server-side `can()` check is the real boundary), and renders each entry as a `Card` linking to the real article via `contentId`.
- **`apps/web/src/pages/[locale]/account/content.astro`** (new) — statically generated and empty, `RequireAuth`-gated, the identical shell `account/caseload.astro` already establishes. Deliberately absent from `routes.ts` for the same reason every other authenticated-only page is: TASK 1.1.3's a11y gate scans every registered route unauthenticated, and this page has no accessible content in its static HTML to find that way.
- **`packages/i18n/src/locales/en.json`** — `assignedContent.*` keys (heading, description, loading/forbidden/error/empty states, the read-more link label).

### Verification

- `pnpm --filter @ndn/web build` — the static output includes an empty `/en/account/content/index.html`, the same size class as `caseload/index.html`'s own empty shell.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green. No new component-level tests, for the same reason this task's own Tests line and `caseload-view.md`'s own TASK 2.5.3 section both give: no React Testing Library/jsdom pattern exists anywhere in `apps/web` yet, and inventing one for a single page is out of this task's scope. Coverage is the backend handler tests (TASK 3.5.1) plus construction-time accessibility — semantic HTML, `role="status"`/`role="alert"` live regions, matching `CaseloadView.tsx`'s own established shape rather than inventing a new one — documented honestly rather than claimed as more than it is.

### What was deliberately not built here

- **A second content-rendering surface.** This task's own explicit "Do NOT" — the article itself is always the existing public blog page, never re-rendered inside the account shell.
- **Component-level tests.** See Verification above.

### Cost (TASK 3.5.2)

£0.00 — one more statically generated, empty Astro page and one React island; no new AWS resource of any kind, and no new backend route (this task consumes 3.5.1's `GET /patients/{id}/content` unchanged).
