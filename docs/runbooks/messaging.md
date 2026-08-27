# Messages: patient↔clinician, rate-limited, the matrix corrected (TASK 3.6.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.6.1](../plan/05-execution-plan.md) · **Decisions:** D-07 · **Depends on:** 3.1.1, 0.5.x (`rate-limiter.ts`)

## What this covers

`04-data-model-rbac.md`'s key shape for this entity: `PAT#<id>` / `MSG#<ts>`, append-only — a message is never edited or removed once sent, the one entity in this table a messaging feature specifically must not compromise on for a clinical record. Two routes: `POST /patients/{id}/messages` (send), `GET /patients/{id}/messages?cursor=` (the thread, chronological, paginated).

## The matrix correction

`04-data-model-rbac.md`'s Messages row stood as `'Patient (own)': C R (own thread)` but `'Sub-clinician (assigned)': R (own patients)` — read-only for the clinician half of a row whose own key-shape note says "Patient↔clinician." This task opens by correcting it: the assigned sub-clinician's cell moves to `C R (own patients)`. Corrected in the doc first (`docs/plan/04-data-model-rbac.md`), then transcribed into `authz-matrix.ts`, per that file's own standing rule — the identical order TASK 2.5.1 followed for "Patient assignment." `authz.test.ts`'s exhaustive generator (`DOC_TABLE`) holds its own independent transcription of the same row; correcting it there regenerated every `can()` assertion for this row automatically — no bespoke test needed, the existing generator caught the corrected cell the same exhaustive way every other cell already is.

## A real finding, despite this task's own title being "the matrix corrected"

This task's own step 2 says `POST /patients/{id}/messages` is now open to "the owning patient or an assigned sub-clinician **or the principal**." The correction above only ever touched the `'Sub-clinician (assigned)'` cell — `authz-matrix.ts`'s `Principal` cell on this row is, and remains, bare `R`. A principal reads any thread (the same cross-caseload oversight every other row in this phase already grants them) but never sends. This is the fourth instance this phase of the identical class of plan-prose inaccuracy `assessment-forms.md`'s TASK 3.3.1 section, `appointments.md`'s TASK 3.4.1 section, and `content-assignment.md`'s TASK 3.5.1 section already found — always over-stating the principal's write access, always caught by a test written against the matrix rather than the task's own description. Notably ironic here: the one task whose own job was fixing a matrix inaccuracy still overclaimed a second one in its own prose, in the same direction, on the same row.

Practical consequence: only a patient or their assigned sub-clinician ever sends a message, so "the other party" a successful send notifies is always resolvable from those two roles alone — see Notification below.

## A second real finding: `Repository<Message>` cannot express this entity's own read

The task's own step 1 cites `Repository<Message>` (0.3.3's generic base) to justify the append-only discipline — no update, no soft-delete method exists to call. But `Repository<T>` is single-key CRUD over `KeyValueStore<T>` (`get(id)`/`put(id, record)`), with no query capability at all, and this entity's own required read (`GET /patients/{id}/messages?cursor=`, "the thread") is inherently one-to-many — there is no single opaque id a `Message` naturally has to begin with; it is identified by `patientId` plus its own timestamp. This is the same mistake `content-assignment.md`'s own TASK 3.5.1 section already found for `ContentAssignment`, now a second instance: a task citing `Repository<T>` to describe an append-only discipline that class's own interface already enforces (no update/delete method to call), while the actual read requirement structurally cannot go through it. Built as a bespoke `MessageStore` instead (`create`, `listForThread`), the identical precedent `appointment-repository.ts`/`content-assignment-repository.ts` already establish — it gives the same append-only guarantee (there is no update/delete method on the interface to begin with) while actually supporting the paginated list read.

## The sort key's disambiguating suffix

`PAT#<id>` / `MSG#<created_at>#<id>` — not `MSG#<created_at>` alone. Two messages in the same thread can now genuinely arrive within the same millisecond (the whole point of the matrix correction above: a patient and their assigned sub-clinician both write to this row), and `DynamoStore`'s conditional `PutCommand` (`attribute_not_exists(pk)`) would silently reject the second one as a "collision" against the identical key. `DynamoAuditLog`'s own sort key already solved this for the identical reason (`<iso-instant>#<newEventId()>` — "the timestamp prefix gives the ordering, the suffix only has to be unique"); `DynamoMessageStore` follows the exact same idiom, `randomUUID`-backed and injectable for tests.

## Rate limiting: why 30/hour, not SMS's 5 or the contact form's 3

`rate-limiter.ts`'s existing `InMemoryRateLimiter` (the generic fixed-window limiter SMS and the contact form already share) is reused directly, keyed by `principal.subjectId` rather than a hashed source IP — the caller here is always a real, already-authenticated identity, not an anonymous visitor. SMS's own 5/hour and the contact form's own 3/hour are both tight by design for a different reason than this feature has: real per-send AWS cost (SMS) or anti-bot posture against anonymous callers (the contact form). Messaging carries neither — it is a real, back-and-forth conversation between two already-authenticated parties, and the limit exists to bound a scripted flood, not a normal exchange. `MESSAGE_RATE_LIMIT_PER_PRINCIPAL = 30` (window: 1 hour) is roughly one message every two minutes sustained for a full hour, comfortably above any real conversational pace. The rate-limit gate sits after body validation in `message.ts`'s own handler (a malformed request is rejected `400` before it can consume a scarce slot on a request that was always going to fail).

## Notification: content-free, to whichever party did not send

Step 5's own requirement: a new message triggers a `Notifier` send to "the other party," content-free — "you have a new message," never the message body, the same privacy posture every other notification template in this codebase states for a mailbox that may not be the recipient's alone to read (`notifications.newMessage`, `packages/i18n/src/notifications/index.ts`, `smsEligible: false`). Given the finding above (only a patient or their assigned sub-clinician ever sends), the resolution is unconditional: a patient-sent message notifies the assigned clinician (email resolved via `AdminGetClinicianEmailPort`, the same `cognito-idp:AdminGetUser` read `assignment-handler.ts` already established for the identical reason — a clinician's email lives in Cognito, not the `CLI#` DynamoDB record); a sub-clinician-sent message notifies the patient (`notificationRecipientFor`, reused directly from `patient-repository.ts`). Best-effort throughout: a notification failing to send never fails the message it describes, the identical `notifyBestEffort`/`notifyClinicianBestEffort` discipline `assignment.ts`'s own step 5 already establishes.

## What was built

- **`docs/plan/04-data-model-rbac.md`** — the Messages row correction (above).
- **`services/api/src/authz-matrix.ts`** — the transcribed correction, and `authz.test.ts`'s `DOC_TABLE` copy.
- **`packages/shared-types/src/message.ts`** (new) — `Message { patientId, senderId, senderRole: 'patient'|'sub-clinician'|'principal-clinician', body }`.
- **`services/api/src/message-repository.ts`** (new) — `MessageStore` (bespoke, per the finding above) and `MessageRepository`, with `MESSAGE_PAGE_SIZE = 50` (the task's own Interfaces line names only `?cursor=`, no `limit=`, so page size is a fixed constant rather than a caller-supplied parameter).
- **`services/api/src/message.ts`** (new) — `createMessageHandler`: the two routes above, flag-gated (404 off), `can()`-gated (403), rate-limited (429), Zod-validated (`.strict()`), the `/patients/me/messages` resolution every other patient-scoped route in this phase already gives, `notifyOtherParty`.
- **`services/api/src/message-handler.ts`** (new) — the deployed Lambda entry, wiring a real `DynamoMessageStore`, `Notifier`, `InMemoryRateLimiter`, and the Cognito-backed `AdminGetClinicianEmailPort`.
- **`services/api/src/dynamo-store.ts`** — `DynamoMessageStore`: `create()` (conditional `PutCommand`, the disambiguating sort-key suffix above), `listForThread()` (main-table `Query`, `begins_with(sk, 'MSG#')`, ascending — chronological without a separate `ScanIndexForward` override — with base64url cursor pagination, the identical `encode/decodeCursor` idiom `DynamoCaseloadStore`'s own GSI3 pagination already established for TASK 2.5.3).
- **`services/api/src/flags.ts`** — `messaging.enabled`, default off.
- **`packages/i18n/src/notifications/index.ts`** / **`packages/i18n/src/locales/en.json`** — the `newMessage` template.
- **`infra/src/data-stack.ts`** — `MessageFunction`, its own least-privilege role: `GetItem`/`PutItem`/`Query` on `PAT#*` (no `UpdateItem` — a message is never edited, so this role has no action that could), `PutItem` on `AUDIT#*`/`NOTIFICATION#*`, `cognito-idp:AdminGetUser` on the clinician pool ARN alone (the same narrow grant `AssignmentFunction`'s own reassignment-notice resolution uses), `ses:SendEmail`, all guardrailed, and the two new routes.
- **`infra/src/config.ts`** — `/ndn/message-function` → `UNMONITORED_LOG_GROUP_NAMES` (bounded by patient count — one conversation per patient, not open traffic — the same reasoning every prior low-volume clinical function in this phase carries).

## Verification

- `authz.test.ts` — 256 tests (up from the exhaustive suite's own prior count), regenerated against the corrected `DOC_TABLE` row; the assigned sub-clinician's own `create`/`read` on this row now pass where they previously failed.
- `message-repository.test.ts` — 6 tests: `senderId` is always the actor's own `subjectId`, never a body-supplied value; the audit entry keyed by `<patientId>#<created_at>`; a sub-clinician-sent message records the correct `senderRole`; the thread returned chronologically (oldest-first); a patient's own thread never leaks another patient's; an empty page for a patient with none.
- `message.test.ts` — 18 tests, including the corrected principal-role case (403, not 201 — the finding above) and the assigned-sub-clinician-can-now-send case (201, not 403 — the matrix correction itself): sending for the owning patient and for an assigned sub-clinician; the notification firing to the correct other party, content-free (asserted against the raw email body string, not the parsed object); `403` for the principal, an unassigned sub-clinician, and a patient guessing another patient's id; `429` once the rate limit is exhausted; `400` for an empty body and a smuggled field, proven not to consume a rate-limit slot; `401`/`404` (flag off); the thread read, its `/me` resolution, its `200` for an assigned sub-clinician and the principal, its `403` for an unassigned sub-clinician and a guessed other-patient id.
- `dynamo-store.test.ts` — a `DynamoMessageStore` suite: `create()`'s conditional `PutCommand` with the disambiguating sort-key suffix; a `ConditionalCheckFailedException` mapped to `AppError('RECORD_ALREADY_EXISTS')`; `listForThread()`'s main-table `Query` (asserted to carry no `IndexName`, i.e. never against a GSI, never a `Scan`); cursor decode/encode round-tripping through `ExclusiveStartKey`/`LastEvaluatedKey`; an undecodable cursor mapped to `AppError('INVALID_CURSOR')`; the empty-thread case.
- `infra/data-stack.test.ts` — both new routes assert `AuthorizationType: 'CUSTOM'`; the flag-reading/audit-table function counts, both guardrail-denial counts, and the `CUSTOM` route-key list all updated (19 → 20); a dedicated `describe('DataStack — message function (TASK 3.6.1)')` block: the `PAT#*` grant (`GetItem`/`PutItem`/`Query`, no `UpdateItem`), the `cognito-idp:AdminGetUser` grant, and the audit-partition/keyless-read guardrails.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green (services/api: 1153 tests; infra: 201 tests).
- `node scripts/check-no-disable-comments.mjs` — clean.

## What was deliberately not built here (as of TASK 3.6.1)

- **The message thread UI.** TASK 3.6.2's own scope, per this phase's established "backend task ships its own page, frontend-only follow-up task wires the account shell" split.
- **Real-time delivery.** No WebSocket, no polling loop — a new message appears on next page load or an explicit refresh, TASK 3.6.2's own Step 2 states this outright as a Phase 4+-adjacent decision this task does not make.
- **Editing or deleting a sent message.** The matrix row's own silence on a `D`-shaped action, and this task's own DoD: "no message can be edited or removed once sent."
- **A `limit=` query parameter on the thread read.** The task's own Interfaces line names only `?cursor=`; page size is a fixed constant (`MESSAGE_PAGE_SIZE`) instead.

## Cost (TASK 3.6.1)

£0.00 net-new — `PAT#`/`MSG#<ts>#<id>` rows are a few hundred bytes each, inside the existing DynamoDB line. No new SMS spend (`newMessage` is never `smsEligible`). One more 128 MB arm64 Lambda inside the always-free allowance.

## TASK 3.6.2 — The message thread, on both sides of the account shell

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 3.6.2](../plan/05-execution-plan.md) · **Requirements:** §5 · **Depends on:** 3.6.1

### What this covers

The read/compose surface for TASK 3.6.1's now genuinely bidirectional messaging — the last page this phase adds to the account shell TASK 2.2.4 built with nothing behind it. `MessageThread.tsx` fetches `GET /patients/me/messages` on mount, renders the thread oldest-first, and offers a compose box that `POST`s a new message and appends it to local state on success — no full page refresh, no real-time transport (step 2's own explicit scope line: no WebSocket, no polling loop; a new message from the other party appears on next page load or an explicit refresh, the same "static page, island decides what to fetch" posture every other Phase 2/3 page takes).

### An honest reading of "both sides"

This task's own title says "on both sides of the account shell," but its Files line names exactly one new component and one new page, its Steps name no patient-id selector, and its Interfaces line says "none new — consumes 3.6.1's two routes" (both of which are patient-scoped, `/patients/{id}/messages`, resolving `/me` only for a signed-in patient principal). There is no mechanism named anywhere in this task for a signed-in clinician to choose which patient's thread to view on this page. Built here as the patient's own account page, consuming `/patients/me/messages` — the identical `/me` resolution every other patient-scoped account page in this phase already uses (`PatientProfile.tsx`, `ClinicalRecordTimeline.tsx`, `NextAppointmentPanel.tsx`, `AssignedContent.tsx`). "Both sides" is read here as both directions of the conversation — read *and* compose — on the patient's own page, which is a real, if narrower, reading than a second UI this task does not otherwise specify. A clinician-facing per-patient thread view (e.g. reached from a future per-patient link on `CaseloadView.tsx`) is a real gap, named honestly rather than invented past what this task actually asks for.

### What was built

- **`apps/web/src/account/MessageThread.tsx`** (new) — a React island: the thread as an ordered list (oldest-first, matching the store's own chronological read), a compose `<form>` with a `<textarea>`, `RequireAuth`-gated, statically-empty-page discipline unchanged. `429` from a rate-limited send surfaces as its own state (`rateLimited`), distinct from a generic `error` — the caller is told to wait, not that something is broken. A sent message is appended to local state immediately from the `POST` response's own `item`, so the sender sees their own message without waiting on a second `GET`.
- **`apps/web/src/pages/[locale]/account/messages.astro`** (new) — statically generated and empty, the identical shell `account/caseload.astro`/`account/content.astro` already establish. Deliberately absent from `routes.ts` for the same reason every other authenticated-only page is.
- **`packages/i18n/src/locales/en.json`** — `messageThread.*` keys (heading, description, loading/forbidden/error/empty states, compose placeholder, send/sending/send-error/rate-limited labels).

### Verification

- `pnpm --filter @ndn/web build` — the static output includes an empty `/en/account/messages/index.html`, the same size class as `caseload/index.html`'s/`content/index.html`'s own empty shells.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green. No new component-level tests, for the same reason this task's own Tests line and every prior page this phase added both give: no React Testing Library/jsdom pattern exists anywhere in `apps/web` yet, and inventing one for a single page is out of this task's scope. Coverage is the backend handler tests (TASK 3.6.1) plus construction-time accessibility — semantic HTML, `role="status"`/`role="alert"` live regions, a `<label>`-associated `<textarea>` for the compose box's own keyboard reachability (this task's own Tests line calls this out explicitly: "a text-entry control is a more direct a11y risk than a read-only list"). **Closed by TASK 5.3.1** ([live-session-accessibility.md](live-session-accessibility.md)): `/en/account/messages` is registered in `account-routes.ts` and axe-scanned in a real, signed-in session on a nightly schedule, against production rather than a per-PR stack.

### What was deliberately not built here

- **A clinician-facing per-patient thread view.** See "An honest reading of 'both sides'" above.
- **Real-time delivery.** This task's own explicit scope line — see What this covers above.
- **Component-level tests.** See Verification above.

### Cost (TASK 3.6.2)

£0.00 — one more statically generated, empty Astro page and one React island; no new AWS resource of any kind, and no new backend route (this task consumes 3.6.1's two routes unchanged).
