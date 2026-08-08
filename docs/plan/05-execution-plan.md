# 7. Execution plan

## Phase 0 — Foundations (nothing user-facing)

### TASK 0.0.1 — Commit the plan

**Milestone:** M0.0 · **Requirements:** — · **Decisions:** D-01…D-28 · **Depends on:** none · **Blocks:** all · **Size:** S · **Cost:** £0.00
**Context.** The plan must be versioned and reviewed like code before any of it is executed.
**Files:** create `docs/plan/00-index.md`, `00-conventions.md`, `01-decisions.md`, `02-risk-register.md`, `03-cost-model.md`, `04-data-model-rbac.md`, `05-execution-plan.md`, `06-gate-checklists.md`, `07-traceability.md`, `08-long-lead.md`, `09-self-audit.md`, `docs/adr/0001..0016-*.md`, `docs/compliance/dpia-skeleton.md`.
**Steps.** 1. `git init` state already exists; create branch `docs/0-0-1-commit-plan`. 2. Write each manifest document verbatim from this plan. 3. Open PR.
**Tests.** Markdown lint + link check in CI (added by 0.2.1; until then, manual link check documented in the PR).
**Verification:** `pnpm docs:lint` (once CI exists) · reviewer confirms every §0.5 file present.
**Flag:** none. **DoD:** all manifest files present; PR opened on a feature branch with the required body. **Rollback:** revert the commit. **Do NOT:** write application code.

### TASK 0.0.2 — Contain the legacy public delete path

**Milestone:** M0.0 · **Requirements:** C-03, C-11, §6.7 · **Decisions:** D-02, D-03 · **Risks:** R-06 · **Depends on:** 0.0.1 · **Blocks:** 0.3.x · **Size:** S · **Cost:** £0.00
**Context.** A publicly invokable Lambda in account 803129122420 holds `s3:DeleteObject` over an unversioned bucket. Every data-protection guard we build later is theatre while this exists. This task is **non-destructive**: it removes capability and adds recoverability, and deletes nothing.
**Steps.** 1. Enable **versioning** on bucket `nourishthenerve` (eu-west-2). 2. Replace `LambdaS3AccessPolicy` with a read-only statement (`s3:GetObject`, `s3:ListBucket`) — **remove `PutObject` and `DeleteObject`**. 3. Delete the Function URL (`AuthType: NONE`) after confirming whether the live brochure site calls it; if it does, keep the URL until G1 and instead restrict CORS to the site origin. 4. Record findings in `docs/runbooks/legacy-estate.md`.
**Interfaces:** IAM policy document; S3 versioning configuration.
**Tests.** Integration: assert the role can `GetObject` and **cannot** `PutObject`/`DeleteObject` (IAM policy simulator, asserted in CI). Negative: unauthenticated call to the Function URL fails or is gone. Regression: brochure site still renders (synthetic fetch of `/` returns 200).
**Verification:** `aws s3api get-bucket-versioning --bucket nourishthenerve` → `Enabled`; `aws iam simulate-principal-policy` returns `implicitDeny` for `s3:DeleteObject`.
**Flag:** none (infrastructure). **DoD:** versioning on; delete/put denied; documented; cost delta £0. **Rollback:** re-attach the previous policy version (versioning stays — it is never harmful). **Do NOT:** delete any object, the bucket, or the `clients/` prefix. **Do NOT** delete the Lambda yet — that is task 1.6.1 at cutover.

### TASK 0.1.1 — Provision the AWS account and identity baseline

**Milestone:** M0.1 · **Requirements:** NFR-03 · **Decisions:** D-01, D-28 · **Risks:** R-07 · **Depends on:** 0.0.1 · **Size:** M · **Cost:** £0.00
**Context.** All subsequent infrastructure lands in a dedicated member account with no human long-lived credentials.
**Steps.** 1. Create the Organization (if absent) in 803129122420; create member account `ndn-prod` with a unique root email; enable MFA on its root user and stop using it. 2. Enable IAM Identity Center; create `NDNAdmin` permission set. 3. Create the GitHub OIDC provider and `ndn-deploy` role with a trust policy scoped to `repo:nourishthenerve/ndn-monolithic:ref:refs/heads/main` **and** pull-request contexts for ephemeral envs. 4. Enable CloudTrail (management events, free tier) and Cost Explorer. 5. Document root-key deletion as **your** action.
**Tests.** Integration: assume `ndn-deploy` from a CI dry-run and confirm it can `cloudformation:DescribeStacks` and **cannot** `iam:CreateUser`. Negative: OIDC trust rejects a token from another repository.
**Verification:** `aws sts get-caller-identity` from CI shows the assumed role, not a user.
**DoD:** no IAM users with access keys exist in the new account. **Rollback:** delete the role; the account remains harmless and free.
**Do NOT:** copy root access keys anywhere. **Do NOT** delete the existing account's keys yourself — that is the owner's action.

### TASK 0.1.2 — Monorepo scaffolding, linting, formatting, type checking

**Milestone:** M0.1 · **Requirements:** NFR-08 · **Decisions:** D-15, D-16 · **Depends on:** 0.0.1 · **Size:** M · **Cost:** £0.00
**Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, plus empty workspace packages per §4.
**Steps.** 1. pnpm workspaces with the §4 layout. 2. Strict TS (`strict`, `noUncheckedIndexedAccess`). 3. ESLint + Prettier + import ordering. 4. Vitest with coverage thresholds configured but not yet enforced (0.2.3 enforces).
**Tests.** Unit: one trivial test per package proving the harness runs. **Verification:** `pnpm -r lint && pnpm -r typecheck && pnpm -r test`.
**DoD:** clean run on a fresh clone. **Rollback:** revert. **Do NOT:** add runtime dependencies not needed by a shipped feature.

### TASK 0.2.1 — CI pipeline with quality gates

**Milestone:** M0.2 · **Requirements:** C-06, C-09, NFR-03, NFR-06 · **Risks:** R-08, R-13 · **Depends on:** 0.1.1, 0.1.2 · **Size:** M · **Cost:** £0.00
**Steps.** 1. `.github/workflows/ci.yml`: install (cached) → lint → typecheck → unit → integration → coverage thresholds → dependency audit → secret scan. 2. Path filters so docs-only PRs skip heavy jobs (protects the 2,000-minute budget). 3. Branch protection requiring CI green. 4. Job summary prints CI minutes used.
**Tests.** Meta: a deliberately failing lint rule on a scratch branch fails the build (evidence in PR).
**Verification:** `gh run list` shows required checks. **DoD:** cannot merge without green CI. **Do NOT:** add `continue-on-error` to any quality gate.

### TASK 0.3.1 — Destructive-primitive lint rule

**Milestone:** M0.3 · **Requirements:** C-03, §6.7 · **Risks:** R-06 · **Depends on:** 0.2.1 · **Size:** M · **Cost:** £0.00
**Context.** Code-layer half of the two-layer guard. Must exist before anything writes data.
**Steps.** 1. Custom ESLint rule banning `DeleteItemCommand`, `DeleteObjectCommand`, `DeleteObjectsCommand`, `BatchWriteItem` with `DeleteRequest`, raw `DELETE`/`TRUNCATE`/`DROP` SQL, and `s3:DeleteObject*` strings in IaC — across `services/`, `apps/`, `packages/`, `infra/` **and** `tests/`. 2. Allowlist only `infra/` constructs that *deny* the action. 3. Wire into CI as a blocking check.
**Tests.** **The guard's own test is the deliverable:** a fixture file containing `DeleteObjectCommand` must fail lint; CI proves the failure. Negative: allowlisted deny-policy file passes.
**Verification:** `pnpm lint:no-destructive` exits non-zero on the fixture.
**DoD:** a PR introducing a destructive primitive cannot merge. **Do NOT:** allow per-file disable comments for this rule.

### TASK 0.3.2 — IAM deny guardrails

**Milestone:** M0.3 · **Requirements:** §6.7, NFR-03 · **Depends on:** 0.1.1, 0.3.1 · **Size:** M · **Cost:** £0.00
**Steps.** 1. Runtime role policy with explicit `Deny` on `s3:DeleteObject`, `s3:DeleteObjectVersion`, `dynamodb:DeleteItem`, `dynamodb:DeleteTable` against protected resources. 2. S3 bucket policy denying the same to the runtime principal. 3. Separate, unused **break-glass role** requiring MFA, documented in a runbook and *not* implemented in application code (§6.8).
**Tests.** Integration against emulated/ephemeral AWS: runtime role `DeleteObject` → `AccessDenied`; `PutObject` to a media prefix → succeeds; policy simulator assertions in CI.
**DoD:** deletion denied at code **and** IAM layers, both proven by tests. **Do NOT:** implement any break-glass deletion code path.

### TASK 0.3.3 — Soft-delete + audit primitives

**Milestone:** M0.3 · **Requirements:** §6.2–6.4, FR-X-03 · **Depends on:** 0.3.1 · **Size:** M · **Cost:** £0.00
**Steps.** Repository base class enforcing `created_at`, `updated_at`, `status` on every write; append-only audit writer; versioned-record helper (new version, never overwrite).
**Tests.** Unit: "delete" sets a status flag and the record remains readable by ID; audit entry written for every mutation; version N+1 never mutates version N. Negative: attempting an in-place overwrite of a clinical record throws.
**DoD:** no repository method exists that removes a row. **Do NOT:** add one "for tests".

### TASK 0.3.4 — Schema separation for future lawful erasure

**Milestone:** M0.3 · **Requirements:** §6 note, NFR-04 · **Risks:** R-04 · **Depends on:** 0.3.3 · **Size:** S · **Cost:** £0.00
**Steps.** Split every person record into `clinical{}` (retention basis) and `personal{}` (name, contact, marketing prefs) attributes so a future human-authorised erasure of specific non-clinical fields needs no migration. Document in the DPIA skeleton.
**Tests.** Unit: projection helpers prove the two sets are independently addressable.
**DoD:** DPIA skeleton records the split. **Do NOT:** implement erasure.

### TASK 0.4.1 — IaC baseline: DNS, certificate, CDN, storage, health check

**Milestone:** M0.4 · **Requirements:** C-07, C-08, NFR-01 · **Depends on:** 0.2.1, 0.3.2 · **Size:** M · **Cost:** +£0.42/mo
**Steps.** 1. CDK app: S3 site bucket (versioned, private, OAC), CloudFront PriceClass_100, ACM cert in us-east-1, HTTP API + `GET /health` Lambda (arm64). 2. Route 53 records for a **staging hostname only** (`next.nourishthenerve.com`) — the apex stays on the legacy site until G1. 3. Security headers + CSP via CloudFront response-headers policy. 4. First production deploy: an "it's alive" page.
**Tests.** Integration: `/health` returns 200 with a version string; CloudFront serves the page over TLS; security headers present. Negative: direct S3 URL is denied (OAC enforced).
**Verification:** `curl -sI https://next.nourishthenerve.com` → 200 + HSTS/CSP.
**Flag:** none. **DoD:** production deploy succeeded from CI via OIDC; apex site untouched. **Rollback:** `cdk destroy` of the new stack leaves the legacy site unaffected. **Do NOT:** change the apex or `www` DNS records in this task.

### TASK 0.5.1 — Budgets and cost alarms

**Milestone:** M0.5 · **Requirements:** C-01, NFR-02 · **Depends on:** 0.4.1 · **Size:** S · **Cost:** £0.00 (≤2 budgets free)
**Steps.** Budget at £20 with alerts at 50/75/90%; anomaly detection; alarm → email. Cost allocation tags on every resource.
**Tests.** Integration: simulate a threshold breach via a forced budget notification and assert the alert fires (evidence in PR — the brief requires alarms *proven* at G0).
**DoD:** alarms demonstrably fire in a test. **Do NOT:** rely on Cost Explorer API polling (it bills per request).

### TASK 0.5.2 — Log retention and volume control

**Milestone:** M0.5 · **Requirements:** FR-X-05 · **Risks:** R-11 · **Depends on:** 0.4.1 · **Size:** S · **Cost:** ~£1.00/mo
**Steps.** 14-day retention on every log group by CDK default; sampled request logging; alarm on ingestion GB/day.
**Tests.** Integration: new log groups are created with 14-day retention (assert in CDK snapshot test).
**DoD:** no log group has infinite retention.

### TASK 0.5.3 — SMS hard-cap mechanism

**Milestone:** M0.5 · **Requirements:** C-02, C-11, NFR-09 · **Risks:** R-01, R-02 · **Depends on:** 0.5.1 · **Size:** M · **Cost:** £0.00 (no SMS sent yet)
**Context.** Built **before** any SMS can be sent, so the cap can never be breached even once.
**Steps.** 1. Atomic monthly counter in DynamoDB (conditional update) holding spend in pence. 2. `canSend()` returns false at the £5 cap — **a block, not an alert**. 3. `+44`-only destination allow-list with E.164 normalisation. 4. Per-principal rate limit. 5. Provider-side monthly spend limit set as an independent backstop. 6. Kill switch parameter in SSM.
**Interfaces:** `sendSms(to: E164, template, vars): Result<Sent, Blocked|Capped|NotUk|RateLimited>`.
**Tests.** Unit: cap boundary at £4.99/£5.00/£5.01; non-UK numbers rejected (+1, +33, +44 spoofs like `+4401`); E.164 normalisation. Integration (emulated): 200 concurrent sends stop at the cap with no overshoot; counter is atomic under contention. **Cost-abuse:** allow-list rejects non-UK; rate limit returns the correct error; kill switch blocks everything.
**Flag:** `sms.enabled` — default **off**, you flip it. **DoD:** tests prove the cap blocks. **Do NOT:** send a real SMS in any test.

### TASK 0.6.1 — Feature flags

**Milestone:** M0.6 · **Requirements:** §10 · **Decisions:** D-23 · **Depends on:** 0.4.1 · **Size:** S · **Cost:** £0.00
**Steps.** SSM-backed flag store, cached in-process with short TTL; typed accessor; default-off for every new flag.
**Tests.** Unit: unknown flag returns false; cache honours TTL. **DoD:** incomplete work can merge dark.

### TASK 0.6.2 — Canary deploy, smoke test, auto-rollback

**Milestone:** M0.6 · **Requirements:** C-06, C-07, NFR-01 · **Risks:** R-08 · **Depends on:** 0.6.1 · **Size:** M · **Cost:** £0.00
**Steps.** 1. Lambda alias with weighted routing (10% → 100% over 5 min). 2. CloudWatch alarm on 5xx/latency wired to the deployment. 3. Post-deploy smoke test hitting `/health` and a real page. 4. Failure → automatic alias rollback. 5. `docs/runbooks/rollback.md`.
**Tests.** Integration: deliberately deploy a failing build to an ephemeral environment; assert automatic rollback and that the previous version still serves.
**DoD:** rollback demonstrated, not described. **Do NOT:** allow a deploy path that bypasses the alias.

### TASK 0.6.3 — Ephemeral per-PR environments

**Milestone:** M0.6 · **Requirements:** §10 · **Depends on:** 0.6.2 · **Size:** M · **Cost:** £0.00 standing
**Steps.** CI job deploys a uniquely-named stack per PR, runs integration + contract + a11y tests, then **destroys it in the same run** (including on failure, via `always()`).
**Tests.** Meta: a PR leaves no residual stack — CI asserts stack count returns to baseline.
**DoD:** zero standing cost proven by a stack-count assertion. **Do NOT:** leave orphaned stacks on failure.

**Gate G0:** production deploys and rolls back safely · guards demonstrably block a destructive change · budget alarms fire in a test · no long-lived credentials exist.

## Phase 1 — Public website

- **TASK 1.1.1** Design system + tokens, WCAG 2.2 AA primitives (large targets, focus states, contrast), reduced-motion support · FR-X-02 · M
- **TASK 1.1.2** i18n framework: ICU catalogues, locale routing, **RTL-safe logical CSS**, missing-translation fallback, lint rule banning hard-coded user-facing strings · FR-X-01, D-04 · M
- **TASK 1.1.3** CI accessibility checks (axe on every page, keyboard-path tests) · FR-X-02, NFR-06 · S
- **TASK 1.2.1** Public pages + navigation + footer with configurable social links · FR-WEB-05 · M
- **TASK 1.2.2** Legal pages (privacy, cookies, terms, accessibility statement, clinical disclaimer) as i18n placeholders you fill · FR-WEB-07 · S
- **TASK 1.2.3** Cookie consent mechanics; **remove the http:// Google Fonts dependency** — self-host fonts (fixes mixed content and a third-party data flow) · FR-WEB-07, NFR-04 · M
- **TASK 1.3.1** Blog model + per-language content + keyword tagging · FR-WEB-01 · M
- **TASK 1.3.2** Blog authoring/editing, publish/unpublish (**never delete**), SEO metadata + hreflang · FR-WEB-01 · M
- **TASK 1.4.1** Contact form → SES → `contact@`, Turnstile spam protection, rate limited · FR-WEB-04, C-11 · M
- **TASK 1.4.2** Testimonials with moderation queue + documented consent record per testimonial · FR-WEB-06 · M
- **TASK 1.5.1** Workshops: model, posters, details, per-language · FR-WEB-02 · M
- **TASK 1.5.2** Stripe Checkout + idempotent webhooks + registration confirmation email · FR-WEB-02, D-13 · M
- **TASK 1.6.1** **G1 cutover:** point apex + `www` at the new distribution; decommission the legacy Lambda (D-02); verify the legacy account is no longer serving traffic · D-02, D-25 · M

**Gate G1:** public site live at the apex, accessible, within cost, legacy estate retired.

## Phases 2–7 — milestone plans + task stubs

*(Elaborated to full §12 detail at each gate, per D-27.)*

| Phase | Milestones | Stub tasks | Notes |
|---|---|---|---|
| **2 — Identity & roles** | M2.1 auth · M2.2 notifications · M2.3 RBAC + audit · M2.4 clinician accounts · M2.5 assignment/reassignment | 2.1.1–2.5.3 (~14) | **Proposed reordering:** pull M2.3 (RBAC spine + audit) earlier — see §9 |
| **3 — Clinical core** | M3.1 patient record · M3.2 diagnosis/care plan/private notes · M3.3 assessment forms · M3.4 appointments + reminders · M3.5 content + media · M3.6 messaging | ~18 | R-09 boundary work concentrated in M3.2 |
| **4 — Video** | M4.1 signalling · M4.2 server-side call authz · M4.3 peer connection + device check + fallback · M4.4 TURN + caps · M4.5 join-button state machine | ~12 | R-03 mitigations in M4.4 |
| **5 — Hardening & launch** | M5.1 load test 10× · M5.2 security review · M5.3 a11y audit · M5.4 **restore drill executed** · M5.5 runbooks + cost reconciliation | ~10 | G5 = WEB IS DONE |
| **6 — Mobile** | M6.1–M6.7 | ~14 | Only after G5; additive versioned API changes only |
| **7 — Post-launch** | Analytics within privacy constraints, cost review, deferred backlog **incl. chatbot (D-05) if solicitor clears scope** | — | |
