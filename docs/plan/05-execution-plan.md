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

### TASK 1.1.1 — Design system + tokens, WCAG 2.2 AA primitives, reduced-motion support

**Milestone:** M1.1 · **Requirements:** FR-X-02 · **Decisions:** ADR-0017 · **Depends on:** 0.1.2, 0.4.1, 0.6.2 · **Blocks:** 1.1.2, 1.1.3, 1.2.1 onward · **Size:** M · **Cost:** £0.00
**Context.** `packages/ui` and `apps/web` are still the empty scaffolds TASK 0.1.2 created; every later Phase 1 page depends on this task's tokens/primitives. No ADR pinned a frontend rendering framework (ADR-0003 covers hosting/delivery only) — this task makes that call, recorded as [ADR-0017](../adr/0017-frontend-framework.md).
**Files:** `packages/ui/package.json`, `packages/ui/src/tokens/{color,space,type,motion}.ts`, `packages/ui/src/components/{Button,Link,Input,Heading,Card,SkipLink,VisuallyHidden}.tsx`, `apps/web/package.json`, `apps/web/astro.config.mjs`, `apps/web/src/pages/index.astro`.
**Steps.** 1. Adopt ADR-0017: **Astro with React islands, TypeScript, static output** (`astro build` → `dist/`) — zero-JS-by-default (helps perf/reduced-motion budgets), first-class file-based i18n routing (feeds 1.1.2), and its static output drops straight into the existing `BucketDeployment` in `infra/src/web-stack.ts` (TASK 0.4.1) with no infra change beyond the source path. 2. `packages/ui/src/tokens/`: CSS custom properties + typed TS export; colour pairs pre-checked for ≥4.5:1 (body text) / ≥3:1 (large text/UI). 3. `packages/ui/src/components/`: primitives built from semantic HTML, every interactive target ≥24×24 CSS px (WCAG 2.2 SC 2.5.8), a token-driven visible `:focus-visible` state (never `outline: none` without a replacement). 4. `motion.ts` + a global rule: every transition wrapped so `@media (prefers-reduced-motion: reduce)` collapses duration to ~0 (SC 2.3.3). 5. Wire `packages/ui` as an `apps/web` dependency; replace `infra/assets/site/index.html`'s placeholder with the real build output as the `BucketDeployment` source.
**Interfaces:**

```ts
// packages/ui/src/tokens/color.ts
export interface ColorToken { css: string; contrastOnLight: number; contrastOnDark?: number }
export const colorTokens: Record<'text' | 'textMuted' | 'brand' | 'focusRing' | 'error', ColorToken>;
```

**Tests.** Unit: a contrast-ratio calculator run against every token pair asserts ≥4.5:1/≥3:1, failing the build if a token regresses. Unit: `Button`/`Input`/`Link` tests assert computed tap-target ≥24px and a non-empty `:focus-visible` style. Integration (Playwright): `page.emulateMedia({ reducedMotion: 'reduce' })` on an animated component asserts effectively-zero duration. Negative: a token deliberately set to 3.9:1 fails the contrast test (proves the guard fires, not just exists).
**Verification:** `pnpm --filter @ndn/ui test && pnpm --filter @ndn/web run build` — build succeeds, `apps/web/dist/index.html` exists.
**Flag:** none. **DoD:** `pnpm --filter @ndn/ui test` passes including contrast/target-size/reduced-motion assertions; the 0.4.1 placeholder page is replaced by the real build. **Rollback:** revert the branch; `web-stack.ts`'s `BucketDeployment` source reverts to `infra/assets/site`, redeploy. **Do NOT:** hand-pick colours without running the contrast checker; ship a component whose only focus indicator was removed via `outline: none`; add a UI framework beyond what ADR-0017 records.

### TASK 1.1.2 — i18n framework: ICU catalogues, locale routing, RTL-safe logical CSS, missing-translation fallback, lint rule banning hard-coded strings

**Milestone:** M1.1 · **Requirements:** FR-X-01 · **Decisions:** D-04, ADR-0012 · **Depends on:** 1.1.1 · **Blocks:** 1.2.1 onward (every user-facing string) · **Size:** M · **Cost:** £0.00
**Context.** D-04 requires "no hard-coded copy anywhere, ever," with RTL-safe primitives from day one even though only English ships at launch — ADR-0012 notes reversal cost is low if done now, high if retrofitted.
**Files:** `packages/i18n/src/index.ts`, `packages/i18n/src/locales/en.json`, `packages/i18n/src/format.ts`, `packages/eslint-plugin-i18n/` (new), `eslint.config.js`, `apps/web/astro.config.mjs`.
**Steps.** 1. `packages/i18n`: ICU MessageFormat catalogues via `intl-messageformat` (new dependency) — one JSON file per locale, keyed by dotted message ID. 2. `t(key, vars?, locale?)`: falls back to the `en` catalogue and logs a structured, non-PII warning — never throws, never renders a raw key. 3. Locale routing: Astro's file-based `[locale]` routing, URL-prefixed (`/en/...`) from day one so a second language is additive routing later, not a URL-scheme change. 4. Audit and convert `packages/ui`'s tokens/components (1.1.1) to CSS logical properties (`margin-inline-start`, `padding-block`, `inset-inline-end`); `dir` driven by locale metadata, default `ltr`. 5. New rule `ndn/no-hardcoded-strings` (`packages/eslint-plugin-i18n`, same plain-ESM+`checkJs` pattern as `packages/eslint-plugin-no-destructive`) banning literal user-facing text in JSX/Astro output not wrapped by `t()`; registered `'error'` for `apps/web/**` in root `eslint.config.js`.
**Interfaces:**

```ts
// packages/i18n/src/index.ts
export type Locale = 'en'; // extended additively when a language is named (LL-08)
export function t(key: string, vars?: Record<string, string | number>, locale?: Locale): string;
```

**Tests.** Unit: `t()` against a key missing from a hypothetical non-`en` locale falls back to `en`, emits one warning, never throws. Unit: ICU plural/date formatting round-trips correctly. Unit (RuleTester): a raw JSX string literal fails `ndn/no-hardcoded-strings`; the same text wrapped in `t()` passes. Integration: a fixture rendered `dir="rtl"` shows no broken logical-property fallback. Negative: a missing catalogue key never crashes the render.
**Verification:** `pnpm --filter @ndn/i18n test && pnpm run lint` (new rule runs inside the existing required lint gate).
**Flag:** none. **DoD:** no user-facing string in `apps/web` bypasses `t()`, enforced by lint not review; `/en/...` routing works; RTL logical-property audit is documented. **Rollback:** revert the branch (avoid reverting after go-live — would change live URLs). **Do NOT:** hard-code date/plural formatting outside the ICU catalogue; add a runtime machine-translation dependency (ADR-0012 rejects this).

### TASK 1.1.3 — CI accessibility checks (axe on every page, keyboard-path tests)

**Milestone:** M1.1 · **Requirements:** FR-X-02, NFR-06 · **Depends on:** 1.1.1, 1.1.2, 0.6.3 · **Blocks:** 1.2.1 · **Size:** S · **Cost:** £0.00
**Context.** TASK 0.6.3's `tests/pr-env/a11y.test.ts` (axe-core + jsdom, one static page) was explicitly built as a lightweight stand-in for the real-browser a11y suite this task adds across every page, now that real routes exist.
**Files:** `tests/pr-env/a11y-full.test.ts`, `tests/pr-env/keyboard.test.ts`, `apps/web/src/routes.ts` (new route manifest), `.github/workflows/ci.yml`.
**Steps.** 1. `apps/web/src/routes.ts`: a checked-in list of every public route (grows through 1.2.x–1.5.x) — the single source both the a11y suite and any future sitemap read from, so a new page can't silently skip the gate. 2. `a11y-full.test.ts`: Playwright + `@axe-core/playwright` (new dependencies), navigates every route against the live ephemeral PR URL (`PR_ENV_BASE_URL`, from 0.6.3), asserts zero `serious`/`critical` violations per page. 3. `keyboard.test.ts`: keyboard-only walkthroughs — tab order matches visual order, a skip-link is first-focusable and jumps to `<main>`, no unintended focus trap, `Enter`/`Space` activate custom widgets. 4. Wire both into the existing `pr-environment` CI job (0.6.3) rather than a new deploy. 5. Promote into `ci-summary`'s required gate once the first live run is green (same pattern already used twice in this repo).
**Tests.** This task's own deliverable is the suite (Steps 2–3). Meta: a scratch page missing a `<main>` landmark is caught by the axe run, then removed.
**Verification:** `pnpm run test:pr-env` against a real ephemeral stack; `gh run view` shows the job green.
**Flag:** none. **DoD:** every route in `routes.ts` is exercised by the axe check on every PR; a keyboard-only pass reaches every route's primary actions. **Rollback:** revert the branch — additive CI only. **Do NOT:** exempt a route from the axe check without a written, reviewed justification next to its `routes.ts` entry; downgrade a `serious`/`critical` finding to non-gating to make CI pass.

### TASK 1.2.1 — Public pages + navigation + footer with configurable social links

**Milestone:** M1.2 · **Requirements:** FR-WEB-05 · **Depends on:** 1.1.1, 1.1.2, 1.1.3 · **Blocks:** 1.2.2, 1.2.3, 1.3.2, 1.4.1, 1.4.2, 1.5.1 · **Size:** M · **Cost:** £0.00
**Context.** First real page content on the new site — replaces the 0.4.1 "it's alive" placeholder and gives every later Phase 1 task a shell to plug into.
**Files:** `apps/web/src/layouts/BaseLayout.astro`, `apps/web/src/pages/[locale]/{index,about,services}.astro`, `apps/web/src/components/{Nav,Footer}.astro`, `apps/web/src/config/social-links.ts`.
**Steps.** 1. `BaseLayout.astro`: `<html lang>`/`dir` from locale metadata, skip-link, `<main>` landmark, imports `packages/ui` tokens. 2. `Nav.astro`/`Footer.astro` built from `packages/ui` primitives only; nav links to every route in `apps/web/src/routes.ts`. 3. `social-links.ts`: a single typed, checked-in config array the footer renders from — "configurable" means editing this file, not markup or a redeploy pipeline of its own. 4. Home/About/Services/Contact-stub pages, all copy `t()`-wrapped (1.1.2's lint rule enforces this). 5. Add every new route to `routes.ts`; point `web-stack.ts`'s `BucketDeployment` at the real build if not already done.
**Tests.** Unit: `social-links.ts` validated by a Zod schema — a malformed entry fails the build, not a runtime 500. Integration (Playwright): every nav link resolves 200; footer renders the configured links. Integration: 1.1.3's a11y/keyboard suite passes against every new route.
**Verification:** `pnpm --filter @ndn/web run build`; 1.1.3's pr-environment suite green against these routes.
**Flag:** none. **DoD:** nav/footer present on every page; every link resolves; social links change via one config file. **Rollback:** revert the branch; `BucketDeployment` reverts to the placeholder. **Do NOT:** hard-code social URLs in `Footer.astro`; add a page not listed in `routes.ts`.

### TASK 1.2.2 — Legal pages (privacy, cookies, terms, accessibility statement, clinical disclaimer) as i18n placeholders

**Milestone:** M1.2 · **Requirements:** FR-WEB-07 · **Depends on:** 1.2.1, 1.1.2 · **Size:** S · **Cost:** £0.00
**Context.** These must exist and be linked before Gate G1, while LL-05 (DPIA) and LL-06 (solicitor sign-off on the erasure tension) remain open per `08-long-lead.md` — this task ships page shells and marked placeholder copy, not final legal text.
**Files:** `apps/web/src/pages/[locale]/legal/{privacy,cookies,terms,accessibility-statement,clinical-disclaimer}.astro`, `packages/i18n/src/locales/en.json` (new `legal.*` keys).
**Steps.** 1. One route per document, added to `routes.ts` and linked from the footer. 2. Each body is an explicit, visibly-marked placeholder banner ("This page is a placeholder pending legal review — do not rely on it."), not just a code comment. 3. Accessibility statement states this project's actual a11y posture (WCAG 2.2 AA target, 1.1.3's automated checks), not generic boilerplate. 4. Clinical disclaimer: placeholder noting the public site provides no diagnosis/treatment; real wording awaits LL-06.
**Tests.** Unit: every legal route's rendered output contains the placeholder-notice banner (fails if someone quietly removes it). Integration: all five pages return 200 and pass the 1.1.3 a11y/keyboard suite.
**Verification:** `pnpm --filter @ndn/web run build`; reviewer confirms all five pages are reachable from the footer.
**Flag:** none. **DoD:** five pages live, linked, each visibly marked as a placeholder pending review. **Rollback:** revert the branch. **Do NOT:** write real privacy/terms/clinical claims as if reviewed; remove the placeholder banner without a recorded LL-05/LL-06 sign-off.

### TASK 1.2.3 — Cookie consent mechanics; remove the http:// Google Fonts dependency, self-host fonts

**Milestone:** M1.2 · **Requirements:** FR-WEB-07, NFR-04 · **Depends on:** 1.2.1, 1.2.2 · **Size:** M · **Cost:** £0.00
**Context.** The legacy site loads Google Fonts over plain `http://` — mixed content and an uncontrolled third-party data flow. The new site is greenfield so this isn't a migration: TASK 0.4.1's CloudFront `ResponseHeadersPolicy` CSP (`default-src 'self'`, no `font-src` override) would already silently block a Google Fonts `<link>` — this task makes self-hosting explicit and adds the consent mechanism FR-WEB-07 needs.
**Files:** `apps/web/src/assets/fonts/*.woff2`, `apps/web/src/styles/fonts.css`, `packages/ui/src/components/CookieBanner.tsx`, `apps/web/src/scripts/consent.ts`.
**Steps.** 1. Self-host the chosen typeface(s) as `.woff2` (Latin subset at launch), `@font-face` in `fonts.css`; no external font `<link>`/`@import` anywhere. 2. `CookieBanner` (built from 1.1.1 primitives): shown on first visit, links to `/legal/cookies` (1.2.2), stores the accept/reject choice in a first-party cookie; no non-essential cookie set before consent. 3. `consent.ts`: a typed gate any future non-essential script must check first. 4. Confirm `web-stack.ts`'s CSP adds no `font-src` exception — document this as deliberate, not an oversight.
**Interfaces:**

```ts
// apps/web/src/scripts/consent.ts
export type ConsentCategory = 'essential' | 'analytics';
export function hasConsent(category: ConsentCategory): boolean;
export function setConsent(categories: ConsentCategory[]): void;
```

**Tests.** Unit: `hasConsent('essential')` always `true`; `hasConsent('analytics')` `false` until set. Integration (Playwright): no font request leaves the page to a non-`self` origin; banner is keyboard-operable (1.1.3); rejecting still lets the site function. Negative: with no consent cookie set, no non-essential script runs.
**Verification:** `curl -sI https://next.nourishthenerve.com/ | grep -i content-security-policy` shows no external `font-src`; the Playwright network-request assertion above.
**Flag:** none. **DoD:** zero third-party font/network requests on first paint; the banner gates every non-essential category; the cookie policy page is linked and accurate. **Rollback:** revert the branch. **Do NOT:** add a Google Fonts (or any third-party font CDN) reference; set a non-essential cookie before consent.

### TASK 1.3.1 — Blog model + per-language content + keyword tagging

**Milestone:** M1.3 · **Requirements:** FR-WEB-01 · **Decisions:** D-07 · **Depends on:** 0.3.1, 0.3.2, 0.3.3, 0.3.4, 0.4.1, 1.1.2 · **Blocks:** 1.3.2, 1.4.2, 1.5.1 · **Size:** M · **Cost:** £0.00 net-new — this is the task that actually incurs the DynamoDB/API Gateway line items `03-cost-model.md`'s M1 column already modelled (~$0.05 DynamoDB + part of the API Gateway line), not a new unmodelled cost.
**Context.** No DynamoDB table is deployed anywhere yet — every Phase 0 data-protection primitive (0.3.1–0.3.4) was built against an in-memory seam specifically so a real table could be dropped in later. Blog content is the first entity to actually deploy `04-data-model-rbac.md`'s single-table design (`CONTENT#<id>`/`META`, GSI2 keyword→content) for real, in `ndn-prod`.
**Files:** `infra/src/data-stack.ts` (new), `infra/bin/app.ts`, `services/api/src/dynamo-store.ts` (new; adds `@aws-sdk/client-dynamodb`/`@aws-sdk/lib-dynamodb`), `services/api/src/content-repository.ts`, `packages/shared-types/src/content.ts`.
**Steps.** 1. `NdnDataStack`: one DynamoDB table, `PAY_PER_REQUEST` (D-07), PITR enabled (D-21, cheap even unused until the Phase 5 restore drill), `RemovalPolicy.RETAIN`. Only **GSI2** (keyword→content) is created now — GSI1/3/4 land with the Phase 2/3 tasks that first need them; adding a GSI later is additive, not a migration. 2. Call `attachDestructiveActionGuardrail` (`infra/src/guardrails.ts`, built in 0.3.2, never yet attached to a real resource) against the new table and the new runtime Lambda role — its first real exercise. 3. `dynamo-store.ts`: a `KeyValueStore<T>` implementation (the 0.3.3 interface) backed by `DynamoDBDocumentClient` — `Repository`/`VersionedRepository` are unchanged; only the store swaps from `InMemoryStore`. 4. `content-repository.ts`: `PK = CONTENT#<id>` / `SK = META`, per-language body on one row (`translations: Record<Locale, {...}>`, not one row per language, so GSI2's keyword query stays single-hop); `keywords: string[]` projected onto GSI2 via `TransactWriteItems` so an item with N keywords is discoverable by all N. 5. Minimal read API only: `GET /content?keyword=` returns published content — authoring is 1.3.2's job.
**Interfaces:**

```ts
// packages/shared-types/src/content.ts
export interface ContentItem extends BaseRecord {
  id: string;
  contentType: 'blog';
  status: 'draft' | 'published' | 'unpublished'; // never 'deleted'
  keywords: string[];
  translations: Record<Locale, { title: string; body: string; excerpt: string }>;
}
```

**Tests.** Unit: `content-repository.test.ts` against `InMemoryStore` proves keyword-projection and status transitions. Integration: an item tagged with 3 keywords is retrievable via all 3 GSI2 queries; `status: 'unpublished'` is excluded from the public read API but still `GetItem`-able by id. Negative: the guardrail denies `DeleteItem` against the real table for the runtime role (policy simulator, real resource this time, not an illustrative ARN).
**Verification:** `pnpm --filter @ndn/infra run synth`; `aws dynamodb describe-table` shows PITR + GSI2; `aws iam simulate-principal-policy` on the new runtime role → `dynamodb:DeleteItem` `explicitDeny`.
**Flag:** `content.readApi.enabled` — default off until 1.3.2 can populate real content. **DoD:** the table and GSI2 exist in `ndn-prod`; the guardrail is attached and proven against it; a content item is queryable by keyword. **Rollback:** `cdk destroy NdnDataStack` — `RemovalPolicy.RETAIN` keeps the table even if the stack is torn down. **Do NOT:** create GSI1/3/4 speculatively; add a `deleteContent`/`removeContent` method anywhere.

### TASK 1.3.2 — Blog authoring/editing, publish/unpublish (never delete), SEO metadata + hreflang

**Milestone:** M1.3 · **Requirements:** FR-WEB-01 · **Depends on:** 1.3.1, 0.3.3, 0.6.1 · **Blocks:** 1.4.2, 1.5.1 (reuse the admin authorizer this task introduces) · **Size:** M · **Cost:** £0.00
**Context.** Phase 2 (Cognito/RBAC) doesn't exist yet — `09-self-audit.md` itself flags this ordering tension and recommends (not yet actioned — the plan's author left it as the account owner's call at G1) pulling M2.3 forward. Authoring needs *some* access control before G1, so this task adds one narrow, explicitly-temporary admin-token gate rather than waiting on Phase 2.
**Files:** `services/api/src/admin-auth.ts` (new), `services/api/src/content-authoring.ts`, `apps/web/src/pages/[locale]/blog/{index,[slug]}.astro`, `packages/shared-types/src/content.ts`.
**Steps.** 1. `admin-auth.ts`: single bearer-token check (`ADMIN_API_TOKEN`, SSM SecureString, D-14) — commented explicitly as a Phase-1-only bridge superseded by Phase 2's Cognito RBAC; reused by 1.4.2/1.5.1, not reimplemented. 2. Authoring endpoints (`POST /content`, `PATCH /content/:id`, `POST /content/:id/publish`, `.../unpublish`) — all admin-token-gated, all via `Repository.update` (0.3.3). No endpoint calls anything delete-shaped — `unpublish` only ever transitions `status`. 3. Per-language `title`/`description`/canonical URL on `translations[locale]`, rendered as `<title>`/`<meta description>`/`<link canonical>`. 4. hreflang: emit `<link rel="alternate" hreflang="{locale}">` + `x-default` per published translation actually present — a single-locale post emits exactly one tag. 5. Public pages read only `status: 'published'` via 1.3.1's read API; an unpublished post's URL resolves to a "no longer available" page, not a raw 404.
**Interfaces:**

```ts
// services/api/src/admin-auth.ts
export function verifyAdminToken(header: string | undefined): boolean; // constant-time compare
```

**Tests.** Unit: missing/malformed/wrong token rejected, correct token accepted, comparison is constant-time. Unit: `unpublish` never removes the row (same `getOwnPropertyNames` assertion pattern 0.3.3 uses). Integration: publish → visible publicly; unpublish → excluded publicly, still `GetItem`-able, still visible to an authenticated admin. Integration: hreflang set matches exactly the populated locales. Negative: an authoring request without the token → 401, mutates nothing (re-read before/after).
**Verification:** `curl -X POST .../content -H "Authorization: Bearer wrong"` → 401; correct token → 201; view-source on a published post shows the expected hreflang set.
**Flag:** `content.authoring.enabled` — default off. **DoD:** a post can be created, edited, published and unpublished end-to-end; unpublished content is never deleted; SEO/hreflang are correct. **Rollback:** revert the branch; rotate/delete the SSM `ADMIN_API_TOKEN` independently if needed. **Do NOT:** add a `DELETE /content/:id` endpoint or any raw `UpdateItem` that empties a row; treat `admin-auth.ts` as permanent.

### TASK 1.4.1 — Contact form → SES → contact@, Turnstile spam protection, rate limited

**Milestone:** M1.4 · **Requirements:** FR-WEB-04, C-11 · **Decisions:** ADR-0009 · **Depends on:** 1.2.1, 1.1.2, 0.6.1 · **Blocks:** 1.5.2 (reuses this task's SES sending identity) · **Size:** M · **Cost:** £0.00 — SES volume already appears in `03-cost-model.md`'s M1 line (~$0.05); Turnstile is free tier. **LL-01 (SES production access) must be resolved before this task's real email send can be proven end-to-end** — flagged as unresolved in the Gate G0 report; raise it now, don't wait for this task to start.
**Context.** The legacy site's own contact form is silently broken today (`legacy-estate.md`: `POST /form` 404s, no route wired) — this is the first working contact form the platform has ever had, built greenfield rather than porting the broken (and unauthenticated, unrate-limited) legacy shape.
**Files:** `services/api/src/rate-limiter.ts` (extracted, generic), `services/api/src/sms-rate-limiter.ts` (updated to depend on it), `services/api/src/contact-form.ts`, `services/api/src/turnstile.ts`, `services/api/src/ses.ts` (new; adds `@aws-sdk/client-sesv2`), `apps/web/src/pages/[locale]/contact.astro`, `infra/src/web-stack.ts`.
**Steps.** 1. Extract the already-principal-generic `RateLimiter` (`tryConsume(principal)`) out of `sms-rate-limiter.ts` into `rate-limiter.ts`; `sms-rate-limiter.ts` re-exports it — no behaviour change, proven by its existing tests passing unmodified. 2. `turnstile.ts`: server-side verify against `https://challenges.cloudflare.com/turnstile/v0/siteverify` (secret key from SSM SecureString), plain `fetch` behind an injected `Fetcher` (matches `smoke-test.ts`'s pattern) so no test calls Cloudflare. 3. `ses.ts`: `SendEmailCommand`, `From` a verified sending identity, `To: contact@nourishthenerve.com` (existing Zoho mailbox, ADR-0009), `ReplyTo` the submitter's address. 4. `contact-form.ts`: same gate-in-order shape as 0.5.3's `sendSms` — Turnstile fail → rejected → rate limit (3/hour per hashed principal) → 429 → SES send → 200; never logs the message body or raw IP, only a hashed key and outcome. 5. Extend the CloudFront `ResponseHeadersPolicy` CSP for the Turnstile origin (`script-src`/`frame-src https://challenges.cloudflare.com`) — the current `default-src 'self'` would otherwise block it. 6. Confirm SES sending identity verification and LL-01's production-access status before relying on delivery to non-verified addresses in a real end-to-end test.
**Interfaces:**

```ts
// services/api/src/contact-form.ts
export type ContactResult = { kind: 'sent' } | { kind: 'blocked'; reason: 'turnstile' | 'rateLimited' };
export function createContactFormHandler(deps: ContactFormDeps): (req: ContactRequest) => Promise<ContactResult>;
```

**Tests.** Unit: Turnstile failure → `blocked/turnstile`, no SES call attempted. Unit: a 4th submission within an hour → `blocked/rateLimited`; a Turnstile-rejected attempt doesn't consume a rate-limit slot. Integration (emulated SES): a valid submission produces exactly one `SendEmailCommand` with the expected `To`/`ReplyTo`. Negative: an oversized/missing field is rejected by Zod before Turnstile is even checked. Negative: no test calls the real Turnstile or SES endpoints.
**Verification:** a deliberately invalid Turnstile token against the ephemeral PR env → rejected; a real submission on the PR env arrives at `contact@nourishthenerve.com`.
**Flag:** `contact.form.enabled` — default off until the PR-env end-to-end send is confirmed. **DoD:** a real message sent through the form arrives at `contact@`; Turnstile and the rate limit both demonstrably block abuse in a test. **Rollback:** revert the branch; flip the flag off via SSM without a deploy. **Do NOT:** log the submitter's raw IP or message body; widen the CSP beyond the one Turnstile origin; reuse the legacy Function URL or its broken `/form` route as a reference.

### TASK 1.4.2 — Testimonials with moderation queue + documented consent record per testimonial

**Milestone:** M1.4 · **Requirements:** FR-WEB-06 · **Risks:** R-04 · **Depends on:** 1.3.1, 1.3.2, 1.4.1 · **Size:** M · **Cost:** £0.00 — same table, no new resource type.
**Context.** FR-WEB-06 requires a documented consent record per testimonial, not just a moderation flag — this applies 0.3.4's clinical/non-clinical schema-separation discipline to a public-facing entity so a future consent withdrawal is a targeted field-level action, not a rewrite (R-04).
**Files:** `services/api/src/testimonial-repository.ts`, `services/api/src/testimonial-moderation.ts`, `packages/shared-types/src/testimonial.ts`, `apps/web/src/pages/[locale]/testimonials/index.astro`.
**Steps.** 1. `PK = TESTIMONIAL#<id>` / `SK = META`, `status: 'pending_review' | 'published' | 'rejected'` — same never-delete `Repository` pattern as content; rejected testimonials stay stored and readable by id. 2. `consent: { textVersion, consentedAt, submitterContactHash }` — a distinct sub-object stamped once at submission; a second write attempt to an existing `consent` object throws rather than overwriting (mirrors 0.3.3's versioned-record guarantee). `submitterContactHash`, not raw contact detail. 3. Public submission form reuses 1.4.1's Turnstile + `rate-limiter.ts` directly — no second anti-abuse implementation. 4. Moderation queue: admin-token-gated (1.3.2) `GET /testimonials?status=pending_review`, `POST /testimonials/:id/{publish,reject}` — both status-only, both audited (0.3.3's `AuditWriter`). 5. Public page renders only `published` testimonials, attribution per the consent record's stated terms (full name / first-name-only / anonymous), not assumed.
**Interfaces:**

```ts
// packages/shared-types/src/testimonial.ts
export interface Testimonial extends BaseRecord {
  id: string;
  status: 'pending_review' | 'published' | 'rejected';
  quote: Record<Locale, string>;
  attribution: { display: 'full' | 'firstNameOnly' | 'anonymous'; name?: string };
  consent: { textVersion: string; consentedAt: string; submitterContactHash: string };
}
```

**Tests.** Unit: a second write to an existing `consent` object throws. Unit: `reject` never removes the row. Integration: submission → `pending_review` → admin `publish` → appears publicly; admin `reject` → never public, still queryable by id and audit log. Negative: Turnstile/rate-limit failure behaves identically to 1.4.1 (shared code path).
**Verification:** `pnpm --filter @ndn/api test`; manual moderation-queue walkthrough against the ephemeral PR env.
**Flag:** `testimonials.submission.enabled`, `testimonials.moderationQueue.enabled` — both default off. **DoD:** every published testimonial has a non-null, immutable consent record; rejected/pending testimonials are never public and never deleted. **Rollback:** revert the branch; flip both flags off. **Do NOT:** publish a testimonial with no consent record (schema-level requirement, not UI-only); allow moderation to mutate `consent`; store the submitter's raw contact detail on the testimonial row.

### TASK 1.5.1 — Workshops: model, posters, details, per-language

**Milestone:** M1.5 · **Requirements:** FR-WEB-02 · **Decisions:** ADR-0005 · **Depends on:** 1.3.1, 1.3.2, 1.2.1 · **Blocks:** 1.5.2 · **Size:** M · **Cost:** £0.00 net-new — poster-image volumes fall within `03-cost-model.md`'s existing S3/CloudFront M1 lines; re-verify at the next gate if poster files turn out large.
**Context.** The first Phase 1 entity needing real media — no media bucket exists yet; ADR-0005 already decided the general shape (S3 + CloudFront, versioned, signed URLs for private per-client media). Workshop posters are deliberately public marketing collateral, not private clinical media, so this task serves them via CloudFront + Origin Access Control **without** signed URLs — the bucket itself stays exactly as locked-down as ADR-0005 requires (no public bucket, no public listing), only the poster *objects* are meant to be publicly viewable once published. Note this distinction explicitly in review; ADR-0005 is not being weakened, just applied to a public-content prefix for the first time.
**Files:** `infra/src/web-stack.ts` (media bucket + `/media` behavior), `services/api/src/workshop-repository.ts`, `services/api/src/media-upload.ts`, `packages/shared-types/src/workshop.ts`, `apps/web/src/pages/[locale]/workshops/{index,[slug]}.astro`.
**Steps.** 1. A second S3 bucket (`MediaBucket`), versioned, `BLOCK_ALL` public access, `RemovalPolicy.RETAIN` — same shape as the site bucket. A `/media/*` CloudFront behavior via Origin Access Control, same pattern already proven for the site bucket. Attach 0.3.2's `attachDestructiveActionGuardrail` to the runtime role against this bucket immediately (deny `DeleteObject`/`DeleteObjectVersion`). 2. `PK = WORKSHOP#<id>` / `SK = META`: per-language `title`/`description`, `dateTimeUtc`, `capacity`, `priceMinorUnits` (GBP pence), `posterKey`. 3. `media-upload.ts`: admin-token-gated endpoint issuing a presigned S3 `PutObject` URL scoped to `workshops/` — the runtime role gets `PutObject` only, never `DeleteObject`. 4. Workshop CRUD mirrors `content-authoring.ts`'s shape — a cancelled workshop transitions `status: 'cancelled'`, poster and details remain retrievable. 5. Public listing/detail pages render published, non-past workshops, poster served via `/media/*`.
**Interfaces:**

```ts
// packages/shared-types/src/workshop.ts
export interface Workshop extends BaseRecord {
  id: string;
  status: 'draft' | 'published' | 'cancelled';
  dateTimeUtc: string;
  capacity: number;
  priceMinorUnits: number; // GBP pence, per D-13
  posterKey?: string;
  details: Record<Locale, { title: string; description: string }>;
}
```

**Tests.** Unit: status transitions never remove a row; `priceMinorUnits` rejected if negative/non-integer (Zod). Integration: a presigned upload URL is scoped to `workshops/` only and expires; the guardrail denies `DeleteObject` against the real media bucket (policy simulator). Integration: an uploaded poster is retrievable at its `/media/...` URL; direct S3 access is denied (OAC, same regression check 0.4.1 runs).
**Verification:** `aws iam simulate-principal-policy` on the runtime role vs. the media bucket → `s3:DeleteObject` `explicitDeny`, `s3:PutObject` `allowed`; `curl -sI` a direct S3 URL → 403.
**Flag:** `workshops.enabled` — default off. **DoD:** a workshop with a poster can be created, published, and rendered publicly; cancelling never deletes it or its media. **Rollback:** `cdk destroy` reverts the bucket/behavior (`RETAIN` keeps uploaded posters). **Do NOT:** make the media bucket or any prefix publicly writable/listable; grant the runtime role `DeleteObject` on it; delete a cancelled workshop's row or poster.

### TASK 1.5.2 — Stripe Checkout + idempotent webhooks + registration confirmation email

**Milestone:** M1.5 · **Requirements:** FR-WEB-02 · **Decisions:** D-13, ADR-0010 · **Depends on:** 1.5.1, 1.4.1, 0.6.1 · **Size:** M · **Cost:** £0.00 recurring infra (Stripe per-transaction fees excluded from C-01, netted from workshop revenue).
**Context.** LL-03 (Stripe account verification/KYC) is an owner action explicitly gating M1.5 in `08-long-lead.md` — this task's code can be built and tested against Stripe test-mode keys regardless, but real payment processing needs LL-03 resolved first.
**Files:** `services/api/src/registration-repository.ts`, `services/api/src/stripe-checkout.ts`, `services/api/src/stripe-webhook.ts` (adds `stripe` dependency), `packages/shared-types/src/registration.ts`, `infra/src/web-stack.ts` (CSP + webhook route).
**Steps.** 1. `PK = WORKSHOP#<id>` / `SK = REGISTRATION#<id>`, `status: 'pending' | 'confirmed' | 'cancelled'` — created `pending` at Checkout Session creation, never deleted. 2. Capacity reservation: an atomic conditional increment on `registeredCount` (`ConditionExpression: registeredCount < capacity`, same shape as 0.5.3's `SpendCounterStore.tryAdd`) at Checkout Session creation; a `checkout.session.expired` webhook releases the reservation. 3. `stripe-checkout.ts`: `POST /workshops/:id/checkout`, GBP Checkout Session, `client_reference_id` = the new `REGISTRATION#<id>`; secret key from SSM SecureString. 4. `stripe-webhook.ts`: verifies the Stripe signature before touching anything. **Idempotency:** a conditional put of `STRIPE_EVENT#<event.id>` (`attribute_not_exists`) — a re-delivered webhook is detected and short-circuited to 200 without reprocessing. 5. On first-seen `checkout.session.completed`: registration → `confirmed`, confirmation email via `ses.ts` (1.4.1's sending identity). 6. Extend the CSP for `https://js.stripe.com`/`https://checkout.stripe.com`.
**Interfaces:**

```ts
// services/api/src/stripe-webhook.ts
export function createStripeWebhookHandler(deps: WebhookDeps): (rawBody: string, signatureHeader: string) => Promise<{ statusCode: 200 | 400 }>;
```

**Tests.** Unit: an invalid signature → 400, no state mutated. Unit: the same `event.id` delivered twice → second delivery is a no-op (200, no second email, no double `confirmed` transition — proven via an email-spy call count of 1). Integration: 50 concurrent checkout-session creations against `capacity: 10` reserve exactly 10, reject the rest (mirrors 0.5.3's 200-concurrent-adds proof). Integration: `checkout.session.expired` releases a reservation. Negative: no test calls the real Stripe API — a fake client satisfies the same interface, Stripe's documented test-mode payloads used as fixtures.
**Verification:** Stripe CLI (`stripe trigger checkout.session.completed`) against the ephemeral PR env's webhook URL, replayed twice, produces exactly one confirmed registration and one email.
**Flag:** `payments.stripeCheckout.enabled` — default off until LL-03 is resolved and the webhook is proven idempotent against real Stripe test-mode events. **DoD:** a real (test-mode) payment produces exactly one confirmed registration and one email, even under a duplicated webhook; capacity is never oversold under concurrency. **Rollback:** revert the branch; flip the flag off via SSM; disable the webhook endpoint in the Stripe dashboard independently of a deploy. **Do NOT:** trust `client_reference_id` without verifying the signature first; process a webhook before the idempotency check; delete a `cancelled` registration or workshop row.

### TASK 1.6.1 — G1 cutover: point apex + www at the new distribution, decommission the legacy Lambda, verify the legacy account no longer serves traffic

**Milestone:** M1.6 · **Decisions:** D-02, D-25, D-08 · **Risks:** R-06 · **Depends on:** 0.0.2, 1.1.1–1.5.2 · **Size:** M · **Cost:** £0.00 net delta to the C-01 envelope — re-confirmed as this task's own Verification step; legacy-account spend decreases, outside the C-01 envelope anyway.
**Context.** The highest-risk task in Phase 1 — the actual DNS cutover away from the legacy site and the final decommission of the R-06 public-delete-capable Lambda that TASK 0.0.2 only *contained*, never removed ("Do NOT delete the Lambda yet — that is task 1.6.1 at cutover"). D-25 held the legacy site untouched until this exact point; D-02 executes here. Two legacy surfaces must not be conflated: the Route 53 zone and the `nourishthenerve-api` Lambda/S3 bucket live in `803129122420`, and the CloudFront distribution currently serving apex/`www` (`d2z3fclxq13w3z.cloudfront.net`, confirmed live at Gate G0) was believed to be in a third, unidentified account. **Corrected 2026-08-21:** it is Amplify-managed, fronted by the `ndn-frontend` app in `803129122420` — so releasing the apex/`www` aliases is a self-service step in an account we control, not a cross-account request. See `docs/runbooks/g1-cutover.md`. The distribution itself still cannot be modified directly (Amplify owns it); the app's domain association is what this task removes.
**Files:** `docs/runbooks/g1-cutover.md` (new), `infra/src/config.ts`, `infra/src/web-stack.ts` (`domainNames`), `docs/plan/03-cost-model.md` (post-cutover reconciliation).
**Steps.** 1. **Pre-flight, no DNS/account changes:** confirm every Phase 1 task (1.1.1–1.5.2) is deployed and green at `next.nourishthenerve.com`, including a full a11y/keyboard pass (1.1.3) and a Core Web Vitals check (Gate G1's own criterion). 2. **Certificate:** request/extend an ACM cert in `us-east-1` covering `nourishthenerve.com` + `www.nourishthenerve.com` (keep `next.` too), DNS-validated via a manual CNAME in the `803129122420` zone (`Z09601252VHSWVDDK2RH4`) — same cross-account manual step 0.4.1 used. 3. **CloudFront:** add `nourishthenerve.com`/`www.nourishthenerve.com` as alternate domain names on the **existing** `NdnWebStack` distribution (not a second one — reuses the already-proven canary/rollback/security-headers/OAC shape), deployed via the ordinary CI `deploy` job (OIDC, `ndn-deploy`) — DNS-invisible so far. 4. **DNS cutover, last, one record type at a time:** in the `803129122420` zone (manual, `default` profile — `ndn-deploy` has no access there), repoint the apex `A`/`ALIAS` and `www` `CNAME`/`ALIAS` from `d2z3fclxq13w3z.cloudfront.net` to `NdnWebStack`'s distribution. Lower the TTL beforehand if currently high, so rollback propagates fast. 5. **Verify immediately:** `curl -sI` both apex and `www` serve the new site (200, expected headers, `/health` version); watch the 0.6.2 canary/smoke-test machinery on this deploy specifically — its first time serving the apex. 6. **Observe before decommissioning:** for 24–48h, monitor `nourishthenerve-api`'s CloudWatch invocation metrics (`803129122420`) to confirm invocations drop to zero (excluding this task's own probes). 7. **Decommission, `803129122420` only, manual:** delete the Function URL first, then the Lambda function itself (satisfies D-02). **Leave the S3 bucket `nourishthenerve` exactly as 0.0.2 configured it** — versioned, read-only, `clients/`/`posts/` untouched; D-03 forbids any code or task here from deleting it. 8. Update `03-cost-model.md`'s reconciliation note with actual vs. modelled M1 spend, per Gate G1's checklist. 9. Before step 7, fix or formally accept the two pre-existing legacy issues `legacy-estate.md` flagged and this gate re-confirmed still live: the unauthenticated `/client/{id}/report` enumeration exposure and the broken `/form` route — decommissioning the Lambda resolves both by removal, but if step 7 is delayed for any reason past this task's completion, that exposure remains live and should be called out, not silently carried forward again.
**Interfaces:** none (infrastructure/DNS task).
**Tests.** Integration: post-cutover, both apex and `www` serve `NdnWebStack` content over TLS with the expected security headers (same assertions 0.4.1 runs against `next.`). Integration: the canary/auto-rollback machinery is exercised for real on this deploy. Regression: every Phase 1 feature verified against the apex domain specifically, not only `next.` (a same-origin/absolute-URL assumption would otherwise surface only now). Negative: after step 7, invoking the deleted legacy Function URL fails, and `aws lambda get-function --function-name nourishthenerve-api` returns `ResourceNotFoundException`. Negative: the S3 bucket's objects remain read-only accessible exactly as 0.0.2 left them — proving the Lambda decommission left the data untouched.
**Verification:** `dig` on both apex and `www` resolve to `NdnWebStack`'s distribution; `curl -sI` both return 200 with the full security-header set; a Core Web Vitals run against the live apex passes Gate G1's bar.
**Flag:** none — this is a DNS cutover, not application behaviour; every feature flag it depends on should already be flipped on and proven in staging before this task runs, not flipped as part of it.
**DoD:** apex and `www` serve the new site exclusively; `nourishthenerve-api` and its Function URL no longer exist in `803129122420`; legacy invocation metrics show zero real post-cutover traffic; Gate G1's checklist (apex serving new site, legacy retired, Core Web Vitals pass) is met and recorded.
**Rollback:** **DNS-only, fast, rehearsed before use:** revert the apex/`www` records in `803129122420` to `d2z3fclxq13w3z.cloudfront.net` (documented ahead of time, not guessed) — restores the legacy experience with zero AWS resource changes, provided step 7 hasn't run. **Once step 7 has run, the Lambda cannot be undeleted** — this is why the observation window and step ordering (DNS first, confirmed stable, *then* delete) exist. A post-step-7 issue is fixed forward on the new stack or rolled back via DNS to legacy CloudFront (untouched throughout), never by resurrecting the deleted Lambda.
**Do NOT:** delete the legacy Lambda, Function URL, or IAM policy before DNS has served the new site through the full observation window; delete the `ndn-frontend` Amplify app or anything else in `803129122420` beyond the one domain association the cutover removes (the account is shared with the unrelated `islamicmaps` estate); delete, empty, or version-purge the S3 bucket `nourishthenerve` or its prefixes under any circumstance (D-03); skip the TTL-lowering step; run this task before every Phase 1 dependency is proven at `next.nourishthenerve.com` first.

### TASK 1.6.2 — SSM-backed feature-flag source, so a flag can actually be turned on

**Milestone:** M1.6 · **Requirements:** §10 · **Decisions:** D-14, D-23 · **Depends on:** 0.6.1, 1.3.1–1.5.2 · **Blocks:** every Phase 2 flag-gated task · **Size:** S · **Cost:** £0.00
**Context.** Added at the Gate G1 review (`gate-g1-report.md` §3a, on its own branch), which found that nine production handlers each wire a `CachedFlagReader` over an `InMemoryFlagSource` that nothing ever writes to. Every flag therefore reads `false` forever and no operator action can change it: blog, blog authoring, contact form, testimonials, workshops, media upload and Stripe checkout are all unreachable in production, verified live. TASK 0.6.1 deferred the SSM implementation correctly — nothing read a flag then — but the deferral was re-noted verbatim in each of the eight tasks after 1.3.1 and never became work. D-23 chose homegrown config-driven flags precisely so a flag could be flipped **without** a deploy; as shipped, only the dark-launch half exists.
**Files:** `services/api/src/ssm-flag-source.ts` (new), `infra/src/flag-parameters.ts` (new), `infra/src/config.ts`, `infra/src/web-stack.ts`, `infra/src/data-stack.ts`, the nine `services/api/src/*-handler.ts`, `docs/runbooks/feature-flags.md`.
**Steps.** 1. `SsmFlagSource implements FlagSource` reading `/ndn/flags/<FlagName>` via `GetParameter` — plain `String`, no `WithDecryption` (a flag's state is not a secret). 2. Fail closed on every path: only the literal `'true'` is on; a missing parameter is the documented steady state and resolves `undefined` quietly; an unrecognised value or an SSM error warns and resolves `undefined`, never throws — a config read must not 500 a working page. 3. `createSsmFlagReader()` collapses the five-line wiring block the nine handlers each repeated into one call, so the TTL, clock and source cannot drift between them. 4. `grantFlagReads` grants `ssm:GetParameter` on `parameter/ndn/flags/*` only — a prefix wildcard, since naming flags individually would mean a deploy before every flip. 5. Set `FLAG_PARAMETER_NAME_PREFIX` on exactly the nine flag-reading functions. 6. Document the operator procedure in the runbook.
**Interfaces:** no change — `FlagSource` and `FlagReader` are unchanged from TASK 0.6.1; this is the implementation that interface was written for.
**Tests.** Unit: prefix construction; `WithDecryption` never sent; `'true'`/`'false'` parsed, everything else refused; missing parameter is quiet; an SSM error resolves off rather than throwing; a parameter's value is never logged. Integration (synth): all nine functions carry the prefix env var and a grant that is exactly `ssm:GetParameter` on `parameter/ndn/flags/*`. **Negative: the grant cannot reach `/ndn/admin-api-token`, `/ndn/stripe-secret-key`, `/ndn/stripe-webhook-secret` or `/ndn/turnstile-secret-key`** — a `parameter/ndn/*` grant would pass the positive assertion and must fail this one. Negative: the health and smoke-test functions hold no flag access.
**Verification:** `pnpm -r lint && pnpm -r typecheck && pnpm test` green; after deploy, `aws ssm put-parameter --name /ndn/flags/<name> --value true` makes the gated route respond within 30s (`FLAG_CACHE_TTL_MS`) with no deploy.
**Flag:** none — this *is* the flag mechanism. **DoD:** an operator can turn any `FlagName` on and off from the CLI without a deploy; every flag is still off at the end of this task. **Rollback:** revert the branch — flags return to permanently-off, the state this task found them in. **Do NOT:** turn any flag on as part of this task; grant `ssm:GetParameter` on `/ndn/*`; use `SecureString` or `GetParametersByPath`; make a failed flag read throw.

**Gate G1:** public site live at the apex, accessible, within cost, legacy estate retired.

## Phase 2 — Identity, authorisation and roles

**Ordering, taken at Gate G1 (2026-08-21).** [09-self-audit.md](09-self-audit.md)'s one pushback on the brief recommended pulling M2.3 (RBAC spine + audit) forward "to sit alongside M1.1 … Your call at G1." Phase 1 shipped before that call was made, so *alongside M1.1* is no longer on the table; what was decided is the surviving half of it — **the spine goes first inside Phase 2, ahead of authentication rather than after it.** The milestones are renumbered against the brief accordingly: **M2.1 is the authorisation spine and audit log** (the brief's M2.3), **M2.2 is authentication** (the brief's M2.1), **M2.3 is notifications** (the brief's M2.2). M2.4 (clinician accounts) and M2.5 keep their numbers; M2.5 is stated as **assignment, reassignment and caseload oversight**, because the principal's cross-caseload view (2.5.3) can only be built once assignments exist and belongs on the assignment side of that line rather than the directory side. The reorder is possible at all because every piece of the spine — a `Principal`, a policy-decision function, a field projection, an append-only audit writer — is pure domain code that needs no Cognito, exactly as 0.3.3/0.3.4 built the soft-delete and person-record primitives against in-memory seams long before a real table existed. Nothing authenticated is built before the boundary it has to respect.

**Phase-wide notes every task below inherits.**

- **Never-delete now covers people.** C-03 and §6.7 were written about clinical rows; in this phase they extend to identity. A patient is `declined` or `suspended`, a clinician is `deactivated`, a Cognito user is disabled — never `AdminDeleteUser`, never a removed row. The user pools carry `deletionProtection` and `RemovalPolicy.RETAIN` for the same reason the table does: deleting a pool destroys every credential in it and cannot be undone.
- **The log-alarm budget is full.** `MONITORED_LOG_GROUP_NAMES` holds 10 entries against a hard AWS ceiling of 10 metrics per alarm (`infra/src/config.ts`, probed against the real API at Gate G1), and `log-retention.test.ts` fails the build if a new `/ndn/*` group appears in neither that list nor `UNMONITORED_LOG_GROUP_NAMES`. Phase 2 adds roughly eight functions. Every task that adds one **names which list it goes in and, if monitored, which group it displaces** — that is a required line in the PR body, not an afterthought.
- **Flags are real now.** TASK 1.6.2 made `SsmFlagSource` the live source, so "default off" in this phase means an operator can turn it on with `aws ssm put-parameter` and no deploy. Every flag below is still off at the end of its own task.
- **Requirement IDs, and a gap this elaboration found.** The tasks below cite `FR-DP-02` and `FR-DP-05` — the only two FR IDs any committed document actually pins to a requirement (`04-data-model-rbac.md` and `02-risk-register.md` respectively) — plus `FR-X-*`/`FR-WEB-*` where Phase 1 already established the mapping, and brief section references elsewhere. **The full FR/NFR matrix is not in the repo:** `07-traceability.md` holds a coverage summary that points at itself for the matrix, and the source requirements brief (`ndn-planning-brief.md`, named in `00-index.md`) was never committed. Nothing in Phase 2 is blocked by this, but "every FR maps to ≥1 task and ≥1 test" is currently unverifiable from the repo alone. Reconstructing the matrix into `07-traceability.md` is an action item on the Gate G1 report and should be closed before G2 audits coverage.
- **No clinical or personal data enters Cognito.** Pools hold credentials, group membership and an email address. Names, contact details, diagnoses and everything else live in the DynamoDB table under `04-data-model-rbac.md`'s key shapes, keyed by the pool's `sub`. This keeps NFR-04's residency story to one region and one store, and keeps `person-record.ts`'s clinical/personal split (0.3.4, R-04) the only place personal data is held.

### TASK 2.1.1 — Principal model and the RBAC policy-decision layer

**Milestone:** M2.1 · **Requirements:** FR-DP-05, NFR-06 · **Decisions:** D-09 · **Risks:** R-09 · **Depends on:** 0.3.3 · **Blocks:** every remaining task in Phases 2–4 · **Size:** M · **Cost:** £0.00 — pure domain code, no AWS resource.
**Context.** `04-data-model-rbac.md` states the authorisation matrix in prose and a table; nothing in the repo implements it. The only access control that exists today is `services/api/src/admin-auth.ts`, whose own header calls itself "one narrow, explicitly-temporary bearer-token gate, not a real auth system: no user identity, no session, no scopes." This task turns the table into code **before** there is anything to authenticate, so that every handler written from here on is built against it rather than retrofitted onto it — the whole reason the milestone was reordered.
**Files:** `services/api/src/principal.ts` (new), `services/api/src/authz.ts` (new), `services/api/src/authz-matrix.ts` (new), `packages/shared-types/src/principal.ts` (new), `packages/shared-types/src/index.ts`.
**Steps.** 1. `Principal`: a `subjectId` (the Cognito `sub`, opaque here), a `role` of `'patient' | 'sub-clinician' | 'principal-clinician'`, an `accountStatus`, and exactly one identity link — `patientId` for a patient, `clinicianId` for either clinician role. No other field; a principal is not a user profile. 2. `authz-matrix.ts` transcribes `04-data-model-rbac.md`'s table as one exported const, cell for cell, with the doc's own row and column labels as the keys — so a reviewer can diff the code against the document line by line rather than reading intent out of `if` statements. 3. `can(principal, action, resource): Decision` reads that const and nothing else. Deny by default: an unlisted entity, an unrecognised role or a missing relationship is a denial, never a fallthrough. 4. **`Action` has no delete member.** `type Action = 'create' | 'read' | 'update'` — the matrix's `D = never` column becomes unrepresentable, so "authorise a delete" is a compile error rather than a policy decision, the same discipline `Repository` uses by having no method that removes a row. 5. Relationship, not just role: a sub-clinician's `read` on a patient resource is allowed only when `resource.assignedClinicianId === principal.clinicianId`, and a patient's only when `resource.ownerPatientId === principal.patientId`. Unassigned and other-patient are the matrix's two `—` columns and are the cases the tests hammer. 6. Assessment resources carry a `fieldSet: 'visible' | 'private'` so the matrix's two assessment rows are two distinct lookups, not one lookup plus a later filter. 7. `accountStatus` gates before role does: anything other than `approved`/`active` can read its own profile and nothing else.
**Interfaces:**

```ts
// packages/shared-types/src/principal.ts
export type Role = 'patient' | 'sub-clinician' | 'principal-clinician';
export type Action = 'create' | 'read' | 'update'; // deliberately no 'delete'

export interface Principal {
  readonly subjectId: string;
  readonly role: Role;
  readonly accountStatus: 'pending' | 'approved' | 'declined' | 'suspended' | 'active' | 'deactivated';
  readonly patientId?: string;
  readonly clinicianId?: string;
}

export interface Resource {
  readonly entityType: string;
  readonly ownerPatientId?: string;
  readonly assignedClinicianId?: string;
  readonly fieldSet?: 'visible' | 'private';
}
```

**Tests.** Unit: the matrix is asserted **exhaustively, not by sample** — a generated table-driven suite over the full cross-product of role × entity × action × relationship, one assertion per cell, so a future edit to `authz-matrix.ts` that widens a cell fails a named test rather than passing silently. Unit: deny-by-default for an unknown entity type, an unknown role, and a principal with neither `patientId` nor `clinicianId`. Unit: `accountStatus: 'pending'` is denied everything except its own profile read. Negative: a patient principal is denied on every `private` assessment lookup, in every relationship, including their own. Negative: a sub-clinician is denied on every unassigned-patient resource. Type-level: a test asserting `can(p, 'delete' as never, r)` does not compile (`// @ts-expect-error`).
**Verification:** `pnpm -r lint && pnpm -r typecheck && pnpm test` green; a reviewer can hold `04-data-model-rbac.md`'s table next to `authz-matrix.ts` and match every cell.
**Flag:** none — nothing calls it yet; a policy module that is off is worse than one that is unused. **DoD:** every cell of `04-data-model-rbac.md`'s RBAC matrix is implemented and individually asserted; no code path in the repo can authorise a delete. **Rollback:** revert the branch — nothing consumes it yet. **Do NOT:** add a `'delete'` action or an `isAdmin` escape hatch; scatter authorisation checks into handlers instead of calling `can()`; let the matrix live anywhere but the one const.

### TASK 2.1.2 — The clinician-private field boundary, at the repository layer

**Milestone:** M2.1 · **Requirements:** FR-DP-05, NFR-06 · **Risks:** **R-09** · **Depends on:** 2.1.1, 0.3.3, 0.3.4 · **Blocks:** 3.2.x (which wires the first real entity through it) · **Size:** M · **Cost:** £0.00
**Context.** R-09 — a clinician's `private{}` notes reaching a patient — is the one risk in the register rated **Critical**, and `09-self-audit.md`'s red-team names it as the second-likeliest way this plan fails: "an export, a log line, an error message, a cache." The register currently points R-09 at 3.2.x. This task builds the chokepoint one phase earlier, for the same reason 0.3.4 built `person-record.ts`'s clinical/personal split before any patient existed: the boundary is cheap to build against an empty system and expensive to retrofit onto a populated one. 3.2.x remains the task that wires assessments through it; **R-09's register entry is amended to `2.1.2` (chokepoint), `3.2.x` (wiring)** as part of this task.
**Files:** `services/api/src/projection.ts` (new), `services/api/src/repository.ts`, `services/api/src/versioned-repository.ts`, `docs/plan/02-risk-register.md`, `docs/runbooks/private-field-boundary.md` (new).
**Steps.** 1. `projection.ts`: `projectFor(principal, record)` strips every `private{}` attribute unless `can(principal, 'read', {…, fieldSet: 'private'})` allows it. One function, one place. 2. Make it structurally unavoidable rather than merely available: the repository read methods return an opaque `Projected<T>` that no serialiser accepts until it has been through `projectFor`, so "forgot to project" is a type error at the call site, not a missing test. 3. Every path out of the process goes through it — the JSON response serialiser, `logger.ts`'s structured line, `errors.ts`'s message construction, and any future export. Named individually because the red-team named them individually. 4. `logger.ts` gains an assertion in its own tests that a record containing a `private` key cannot be logged, on any level. 5. 100% branch coverage on `projection.ts` is a CI condition, not an aspiration — the coverage config gets a per-file threshold for this file alone. 6. The runbook records the invariant, the negative-test convention every future endpoint owes ("negative test per endpoint, forever" — NFR-06), and how to add one.
**Interfaces:**

```ts
// services/api/src/projection.ts
export type Projected<T> = T & { readonly __projected: unique symbol };
export function projectFor<T>(principal: Principal, record: T): Projected<Partial<T>>;
```

**Tests.** Unit: a record with `visible{}` and `private{}` projects to both for an assigned sub-clinician and the principal clinician, and to `visible{}` alone for the owning patient, an unassigned clinician and any other patient. Unit: projection is applied to nested structures and to arrays of records, not just top-level objects. Negative: `logger` refuses a payload containing a `private` key. Negative: an `AppError` message built from a record carries no `private` content. Type-level: serialising an unprojected record does not compile. Coverage: `projection.ts` at 100% branches or CI fails.
**Verification:** `pnpm test:coverage` shows `projection.ts` at 100% branches; the type-level negatives are in the suite as `// @ts-expect-error` assertions.
**Flag:** none. **DoD:** no patient-reachable code path can emit a `private{}` field, and the compiler — not review — is what enforces it. **Rollback:** revert the branch. **Do NOT:** add a `skipProjection` / `raw` option "for admin"; project in a handler or a view; widen `Projected<T>` into a plain cast.

### TASK 2.1.3 — Persistent append-only audit log, and the principal's read of it

**Milestone:** M2.1 · **Requirements:** §6.2–6.4, NFR-06 · **Decisions:** D-07, D-21 · **Depends on:** 2.1.1, 1.3.1 · **Blocks:** 2.2.3, 2.4.1, 2.5.1 · **Size:** M · **Cost:** £0.00 net-new — audit rows are a few hundred bytes each and fall inside `03-cost-model.md`'s existing DynamoDB line; re-check at G2 against real write volume.
**Context.** `services/api/src/audit.ts` defines `AuditWriter` and exactly one implementation — `InMemoryAuditLog`, an array in a Lambda's memory. Every `create`, `update`, `soft-delete`, `publish`, `unpublish`, `reject`, `cancel` and `confirm` the platform has ever performed has been written to it and discarded when the invocation ended. Its header says why ("no DynamoDB table exists yet"); `NdnDataStack` shipped at 1.3.1 and that sentence stopped being true. This is the same shape of finding as Gate G1 §3a's flag source: a correctly-deferred seam that nothing came back for. Nothing in Phase 2 can be reviewed after the fact until it is fixed, and audit is the only mechanism that makes an authorisation boundary reviewable at all.
**Files:** `services/api/src/audit.ts`, `services/api/src/dynamo-audit-log.ts` (new), `services/api/src/audit-read-handler.ts` (new), `infra/src/data-stack.ts`, `infra/src/config.ts`, `docs/runbooks/audit-log.md` (new).
**Steps.** 1. `DynamoAuditLog implements AuditWriter` writing `PK = AUDIT#<yyyy-mm-dd>` / `SK = <iso-instant>#<ulid>`, per `04-data-model-rbac.md`. Date-partitioned so a day's events are one query and no partition grows unbounded. 2. **`AuditEvent` gains the `where` the data model asks for and the type never had** — today it is who/what/when only (`at`, `actor`, `action`, `entityType`, `entityId`). Add `sourceIp` and `requestId` from the API Gateway event, plus the actor's `role`, so "who" is a principal rather than a bare string. 3. Append-only, enforced three ways and not by convention: the interface exposes no update or delete; the write is a `PutCommand` conditioned on `attribute_not_exists(pk)` so a colliding key fails rather than overwrites; and `attachDestructiveActionGuardrail` already denies `DeleteItem` to the role. 4. The writer's IAM grant is `dynamodb:PutItem` **only** — no read, no update — so a compromised writer cannot read the log it appends to. 5. **No PII and no clinical content in an audit row.** Identifiers only, per `00-conventions.md`; the row records that patient `PAT#123`'s care plan was updated, never what it now says. 6. Audit rows never expire — no TTL attribute anywhere near this partition. 7. `GET /audit?date=` behind `can(principal, 'read', { entityType: 'audit' })`, which the matrix allows to the principal clinician alone. 8. A write failure is **not** swallowed: if the audit write fails, the operation that triggered it fails too. An unauditable change to clinical data is worse than a rejected one. 9. Log group `/ndn/audit-read-function` → `UNMONITORED_LOG_GROUP_NAMES` (a principal-only endpoint, the lowest-volume class in the estate, and the alarm's ten slots are full).
**Interfaces:**

```ts
// services/api/src/audit.ts — added fields, existing ones unchanged
export interface AuditEvent {
  readonly at: string;
  readonly actor: string;        // subjectId, not a name
  readonly actorRole: Role;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly sourceIp: string;
}
```

**Tests.** Unit: every existing `AuditAction` round-trips through the Dynamo writer. Unit: a duplicate `<ts>#<id>` throws rather than overwriting. Unit: a failed audit write propagates and the caller's operation fails. Integration: a day's events come back in `<ts>` order from one query. Integration (synth): the writer role holds `dynamodb:PutItem` and no `GetItem`/`Query`/`UpdateItem` on the table. Negative: `GET /audit` as a patient and as a sub-clinician → `403`, both asserted. Negative: no audit row in any test fixture contains a value from a record's `personal{}` or `clinical{}` half — a repo-wide assertion, not a spot check. Negative: `InMemoryAuditLog` is no longer imported by any production handler (a lint-level assertion, the same shape as Gate G1 §3a's fix).
**Verification:** `pnpm -r lint && pnpm -r typecheck && pnpm test` green; after deploy, an authoring action produces a queryable `AUDIT#<today>` row and `aws iam simulate-principal-policy` returns `implicitDeny` for `dynamodb:Query` on the writer role.
**Flag:** `audit.readApi.enabled` — default off; the *writer* is not flagged, because an audit log that can be switched off is not an audit log. **DoD:** every repository write lands a durable audit row carrying who, what, when and where; nothing can amend or remove one; the principal clinician can read a day's events and nobody else can. **Rollback:** revert the branch — the writer reverts to in-memory, which is the state this task found. Rows already written are retained (the table is `RETAIN`). **Do NOT:** put a TTL on an audit row; grant the writer read access; add an `updateAuditEvent` for any reason; write a patient name, an email address or clinical text into an audit row; let an audit-write failure be caught and ignored.

### TASK 2.2.1 — Cognito: two user pools, patient passwordless, clinician TOTP

**Milestone:** M2.2 · **Requirements:** NFR-03, NFR-04 · **Decisions:** **D-09, ADR-0004 (amended by this task)** · **Risks:** R-07 · **Depends on:** 2.1.1 · **Blocks:** 2.2.2, 2.2.3, 2.4.1 · **Size:** M · **Cost:** £0.00 — `03-cost-model.md` carries Cognito Essentials at $0 on 509 MAU against 10,000 free. **Re-verify the tier's free allowance and price as this task's first step** — D-09's figure was verified 2026-08-07 and the gate checklist requires re-verification past 90 days; this task is the first that actually depends on it.
**Context.** ADR-0004 records "Cognito Essentials" and nothing else, and there is a constraint underneath it that the one-line ADR does not survive contact with. D-09 wants **TOTP for clinicians and email-OTP for patients**, and Cognito's MFA policy is *pool-wide*: `REQUIRED` would stack a second factor on top of a patient's passwordless email OTP, and `OPTIONAL` cannot compel a clinician to enrol. One pool cannot hold both policies.
**Decision this task takes, and records as an ADR-0004 amendment: two user pools.** `ndn-patients` — self sign-up on, passwordless email OTP, no MFA. `ndn-clinicians` — self sign-up **disabled entirely**, password plus `REQUIRED` TOTP. The gain beyond the MFA policy is structural: a patient credential cannot become a clinician credential, because they are not in the same directory. Group membership inside one pool is a softer boundary than that, and on a clinical system the harder one is worth its cost. **The cost is real and named:** API Gateway's built-in JWT authorizer binds one issuer per authorizer and one authorizer per route, so two issuers mean the Lambda authorizer TASK 2.2.2 builds instead. **Rejected:** one pool with groups (cheaper, lower latency, and the built-in authorizer would do — rejected on the MFA policy conflict above, which has no workaround that does not involve a Pre-Authentication trigger reimplementing MFA enforcement that Cognito already does properly one pool boundary away).
**Files:** `infra/src/auth-stack.ts` (new), `infra/bin/app.ts`, `infra/src/config.ts`, `docs/adr/0004-auth.md`, `docs/runbooks/cognito-user-pools.md` (new).
**Steps.** 1. `NdnAuthStack`, `eu-west-2` (NFR-04 — the pools hold email addresses, so they stay in-region like everything else). 2. Both pools: `deletionProtection: ACTIVE`, `RemovalPolicy.RETAIN`, `selfSignUpEnabled` true for patients and false for clinicians, `signInAliases: { email: true }`, `standardAttributes` limited to a required, mutable email — nothing else, per this phase's "no personal data in Cognito" note. 3. Patients: Essentials-tier passwordless email OTP as the first factor; no password; account recovery by email only. 4. Clinicians: password policy at CDK's strong default, `mfa: REQUIRED`, `mfaSecondFactor: { otp: true, sms: false }` — SMS as a second factor is off deliberately, both for R-02 (it is a spendable path) and because a phone-number factor is a poorer one. 5. One app client per pool, `authFlows` limited to what 2.2.4 uses, **no client secret** (a public browser client cannot hold one), PKCE required, callback/logout URLs on `SITE_ORIGIN` only. 6. Refresh-token validity 30 days, access/ID tokens 60 minutes; `enableTokenRevocation` on, so 2.4.1's deactivation is immediate rather than eventual. 7. Advanced/threat-protection features are **not** enabled — they are a paid tier, and the honest position is that £0 buys the directory and the MFA, not the risk engine. Recorded in the ADR rather than assumed. 8. Both pool IDs and client IDs become `config.ts` constants (they are identifiers, not secrets). 9. `attachDestructiveActionGuardrail`'s pattern extends to identity: the deploy role gets an explicit `Deny` on `cognito-idp:DeleteUserPool`, `DeleteUserPoolClient` and `AdminDeleteUser`, the same shape 0.3.2 uses for the table and the buckets.
**Interfaces:** none in application code — this task deploys infrastructure and exports identifiers.
**Tests.** Unit (synth): both pools carry `DeletionProtection: ACTIVE` and `RemovalPolicy.RETAIN`; the clinician pool has `MfaConfiguration: ON` with `SOFTWARE_TOKEN_MFA` and **not** `SMS_MFA`; the patient pool has self sign-up enabled and the clinician pool has it disabled. Unit (synth): neither app client has a generated secret; both require PKCE; callback URLs contain no host other than `SITE_ORIGIN`. Negative (synth): the deploy role's policy contains the three `Deny` statements. Negative: no standard or custom attribute beyond email is configured on either pool.
**Verification:** `pnpm --filter @ndn/infra run synth`; after deploy, `aws cognito-idp describe-user-pool` on both confirms the MFA and sign-up settings; `aws iam simulate-principal-policy` on `ndn-deploy` returns `explicitDeny` for `cognito-idp:AdminDeleteUser`; the re-verified Cognito price is recorded in `03-cost-model.md` whether or not it changed.
**Flag:** none — a deployed, empty user pool with no authorizer in front of it is inert. **DoD:** two pools exist in `ndn-prod` with the stated policies; no clinician can exist without TOTP; no patient is asked for a second factor; neither pool can be deleted by the deploy role; ADR-0004 records the two-pool decision and what it costs. **Rollback:** `cdk destroy NdnAuthStack` before any real user exists — after that, **rollback is forward only**: `RETAIN` and deletion protection are there precisely so a bad deploy cannot take the directory with it. **Do NOT:** enable SMS MFA; put a name, phone number or any clinical attribute on a pool; give a browser client a secret; enable self sign-up on the clinician pool; use `AdminDeleteUser` anywhere, in code, scripts or by hand.

### TASK 2.2.2 — Lambda authorizer: verify the token, resolve the `Principal`, fail closed

**Milestone:** M2.2 · **Requirements:** NFR-03, NFR-05, NFR-06 · **Decisions:** D-06 · **Risks:** R-09 · **Depends on:** 2.2.1, 2.1.1, 2.1.3 · **Blocks:** 2.2.3, 2.2.4, 2.4.x, 2.5.x · **Size:** M · **Cost:** £0.00 — one more 128 MB arm64 function inside the always-free Lambda allowance; authorizer results are cached by API Gateway so it is not invoked per request.
**Context.** 2.2.1's two issuers rule out API Gateway's built-in JWT authorizer. This is the function that takes its place, and it is the single most security-sensitive piece of code in the repo: everything downstream trusts the `Principal` it produces. It is also the only place a JWT is ever parsed — no handler reads the `Authorization` header, ever.
**Files:** `services/api/src/authorizer-handler.ts` (new), `services/api/src/jwt-verify.ts` (new), `services/api/src/request-principal.ts` (new), `infra/src/web-stack.ts`, `infra/src/data-stack.ts`, `infra/src/config.ts`.
**Steps.** 1. A `REQUEST` authorizer with `Authorization` as its identity source and a 300-second result cache — the cache is keyed on the header, so a revoked token still lives at most five minutes; that window is stated in the runbook rather than left to be discovered. 2. Verify with `aws-jwt-verify` (AWS's own library, so JWKS fetching, caching and rotation are not hand-rolled): signature, `exp`, `iss` against exactly the two known pool issuers, `aud`/`client_id` against the two known clients, and `token_use` pinned to a single value. 3. **Role comes from the issuer, never from a claim the client could influence** — a token from the clinician pool is a clinician, a token from the patient pool is a patient; `principal-clinician` versus `sub-clinician` then comes from `cognito:groups`, which only an admin action can set. 4. Look up the account/record status once and put it in the `Principal`, so a suspended patient's token stops working within the cache window rather than at the next sign-in. 5. `request-principal.ts` gives handlers `requirePrincipal(event)`, which reads the authorizer context and throws `AppError('UNAUTHENTICATED')` if it is absent or malformed — a handler can never construct a `Principal` from a header itself. 6. Fail closed on every path: any verification failure, JWKS fetch failure, or unexpected shape denies. **A 500 in this function is a denial, not an allow**, and is asserted as such. 7. Log the decision — subject, issuer, route, allow/deny — as an identifiers-only structured line, and never the token, never a claim body. 8. Log group `/ndn/authorizer-function` → `MONITORED_LOG_GROUP_NAMES`, **displacing `/ndn/media-upload-function`**, which moves to `UNMONITORED_LOG_GROUP_NAMES`: the authorizer is on the path of every authenticated request in the system and media upload is an admin-gated occasional one. The swap is recorded in `config.ts` alongside the list, per that file's own instruction.
**Interfaces:**

```ts
// services/api/src/request-principal.ts
export function requirePrincipal(event: APIGatewayProxyEventV2WithLambdaAuthorizer): Principal;
```

**Tests.** Unit: a well-formed token from each pool resolves to the right role and identity link. Negative, each its own named test: expired token; token signed with the wrong key; `alg: none`; an RS256 token re-signed as HS256 using the public key as the secret; issuer of the *other* pool on a role-restricted route; wrong `aud`; wrong `token_use`; absent header; `Bearer` with an empty token; a `cognito:groups` claim asserting `principal-clinician` on a *patient*-pool token. Negative: a JWKS fetch failure produces a denial, not an allow — this is the test that proves 500-means-deny. Negative: no test fixture's log output contains a token or a claim value. Integration (synth): every protected route on both HTTP APIs carries this authorizer; a test enumerates the routes so a new unprotected one fails the build.
**Verification:** `pnpm test` green; against the deployed API, a valid patient token gets `200` on a patient route and `403` on a clinician route, and a token from the clinician pool gets `403` on a patient-only route; `curl` with no header gets `401`.
**Flag:** none — an authorizer behind a flag is an authorizer that can be turned off. **DoD:** no protected route is reachable without a verified token from a known pool; the role a request runs as is derived from the issuer, not from anything the caller can set; every failure mode denies. **Rollback:** revert the branch — the routes it protects are all introduced by this phase and revert with it. **Do NOT:** trust any claim for role that a client could influence; read the `Authorization` header in a handler; cache a decision longer than the token's own life; return `Allow` on an internal error; log a token or a claim body; disable `enableTokenRevocation` to make the cache simpler.

### TASK 2.2.3 — Patient self-registration, and the approval lifecycle on the record

**Milestone:** M2.2 · **Requirements:** §5 (patient registration and approval) · **Decisions:** D-03, D-09 · **Risks:** R-04 · **Depends on:** 2.2.2, 2.1.3, 0.3.4 · **Blocks:** 2.5.1 · **Size:** M · **Cost:** £0.00 — within the modelled DynamoDB and SES lines.
**Context.** The platform's front door: a patient registers themselves, and is then *approved* by a clinician before they can see anything. Registration and approval are deliberately separate — a Cognito account existing is not the same as a patient record being live, and conflating them is how a stranger ends up inside a caseload. The patient record is the first real user of `person-record.ts` (0.3.4), whose header has said since Phase 0 that "wiring a real entity (patient, …) onto it is Phase 2/3."
**Files:** `services/api/src/patient-repository.ts` (new), `services/api/src/registration-handler.ts` (new), `packages/shared-types/src/patient.ts` (new), `infra/src/auth-stack.ts`, `infra/src/data-stack.ts`, `docs/runbooks/patient-registration.md` (new).
**Steps.** 1. `PAT#<id>` / `PROFILE`, built on `PersonRecord<Clinical, Personal>`: name, contact details and marketing preferences in `personal{}`, everything with a clinical retention basis in `clinical{}` — the split R-04 and the DPIA depend on, in place from the first record rather than migrated in later. 2. `account_status: 'pending' | 'approved' | 'declined' | 'suspended'` and `record_status` are separate fields, per `04-data-model-rbac.md`. **`declined` is a status, never a deleted row**, and neither is `suspended`. 3. A Post-Confirmation trigger on the patient pool creates the profile in `pending`, keyed by the pool's `sub`. The trigger is idempotent — Cognito retries — and a failure surfaces rather than leaving a confirmed account with no record. 4. Until approval, `can()` (2.1.1) already allows exactly one thing: reading their own profile. This task adds no special case; it relies on the spine, which is the point of having built it first. 5. Registration, approval, decline and suspension each write an audit row (2.1.3) with the acting principal. 6. A registration confirmation email goes out through SES's existing verified identity and configuration set — **content-free**: "your registration has been received", no clinical language, no name in the subject. 7. Rate-limit registration per source IP with `rate-limiter.ts` (0.5.x), and require Turnstile on the form, the same guards TASK 1.4.1's contact form uses. 8. Log group `/ndn/registration-function` → `UNMONITORED_LOG_GROUP_NAMES`.
**Interfaces:**

```ts
// packages/shared-types/src/patient.ts
export interface PatientPersonal { fullName: string; email: string; phone?: string; marketingOptIn: boolean }
export interface PatientClinical { referralSource?: string; presentingCondition?: string }
export interface Patient extends PersonRecord<PatientClinical, PatientPersonal> {
  id: string;
  account_status: 'pending' | 'approved' | 'declined' | 'suspended';
  assigned_clinician_id?: string;
  keywords: string[];
}
```

**Tests.** Unit: the Post-Confirmation trigger is idempotent under replay — two invocations leave one record and one audit row. Unit: every status transition is recorded; no transition removes a record. Integration: a `pending` patient's token can read their own profile and gets `403` on every other route, asserted route by route. Negative: a `declined` patient's record is still `GetItem`-able and their token is denied everywhere. Negative: the confirmation email body contains no clinical term and no name in the subject. Negative: no code path writes to `clinical{}` during self-registration except the two referral fields above.
**Verification:** end-to-end against the deployed pool: sign up, confirm, and observe a `pending` `PAT#` record plus one audit row; the same token then fails every clinical route.
**Flag:** `auth.patientRegistration.enabled` — default off until 2.5.1 exists to approve anyone, so nobody can register into a system with no route out of `pending`. **DoD:** a patient can create an account; the account grants nothing until a clinician approves it; every transition is audited; no path deletes a person. **Rollback:** flip the flag off via SSM — registration closes with no deploy, and existing records are untouched. **Do NOT:** grant any access on `pending`; delete or overwrite a `declined` record; put clinical content in the confirmation email; auto-approve, for any reason, including for testing.

### TASK 2.2.4 — Authenticated web shell: PKCE exchange, `HttpOnly` cookies, protected routes

**Milestone:** M2.2 · **Requirements:** FR-X-02, NFR-03, NFR-06 · **Decisions:** D-08, ADR-0017, ADR-0003 · **Depends on:** 2.2.1, 2.2.2, 1.1.1, 1.1.2 · **Blocks:** every authenticated page in Phases 3–4 · **Size:** M · **Cost:** £0.00 — one more Lambda and one more CloudFront behaviour, both inside existing free allowances.
**Context.** D-08 and ADR-0017 put the site on S3 + CloudFront with no server runtime, which collides with the only good place to keep a refresh token. There is no server on the static origin to set an `HttpOnly` cookie, so the obvious paths — token in `localStorage`, token in `sessionStorage` — leave a long-lived credential to a patient's clinical record readable by any script that gets onto the page. That is not an acceptable trade on this data, and the strict CSP shipped at 1.2.3 mitigates but does not remove it.
**Resolution: a token-exchange endpoint on the existing HTTP API, proxied same-origin through CloudFront** — the identical shape `/health` and `/contact` already use (`web-stack.ts`'s `additionalBehaviors`). The browser never handles a refresh token: it gets an authorization code, posts it to `/auth/token` on its own origin, and the Lambda performs the PKCE exchange and returns `Set-Cookie: HttpOnly; Secure; SameSite=Lax`. The access token stays in memory in the React island for its hour; refresh is another same-origin call. **Rejected:** Amplify's default browser storage (simplest, and the reason most tutorials use it — rejected because it puts a refresh token where script can read it, on a system holding clinical records).
**Files:** `services/api/src/auth-token-handler.ts` (new), `apps/web/src/auth/` (new — `session.ts`, `SignIn.tsx`, `RequireAuth.tsx`), `apps/web/src/pages/[locale]/account/` (new), `infra/src/web-stack.ts`, `packages/i18n/src/en.ts`, `docs/runbooks/web-authentication.md` (new).
**Steps.** 1. `/auth/*` as a new CloudFront behaviour onto the existing HTTP API origin, `CACHING_DISABLED`, `ALLOW_ALL` methods, the same response-headers policy — so the whole flow is same-origin and the CSP already covers it. 2. `POST /auth/token` exchanges an authorization code with PKCE against the right pool for the client, and `POST /auth/refresh` and `POST /auth/signout` complete the set; sign-out revokes the refresh token server-side (2.2.1 enabled revocation) rather than only dropping the cookie. 3. Cookies: `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, host-only on the apex, `Max-Age` matching the refresh token's own life. 4. `SameSite=Lax` plus a `POST`-only exchange covers CSRF for these routes; the reasoning goes in the runbook rather than being implied. 5. The React island holds the access token in a closure — not in a global, not in `window`, not in `localStorage` — and refreshes it on `401`. 6. `RequireAuth` renders nothing until the session resolves, so no protected content is ever in the DOM before authentication; the *page* stays statically generated and empty, which keeps ADR-0017's static-output decision intact. 7. Every string through `t()` — the i18n lint rule is in the required gate and will fail the build otherwise. 8. Sign-in, sign-out, error and loading states meet the 1.1.1 primitives and 1.1.3's axe + keyboard suites; the OTP input in particular is a real keyboard-accessibility trap and gets its own test. 9. Log group `/ndn/auth-token-function` → `UNMONITORED_LOG_GROUP_NAMES`.
**Interfaces:** HTTP only — `POST /auth/token`, `POST /auth/refresh`, `POST /auth/signout`, all same-origin, all cookie-bearing.
**Tests.** Unit: PKCE verifier generation and the code exchange, with a mocked Cognito client. Unit: every cookie carries all four attributes — a table-driven assertion, so dropping one fails. Negative: the response body of every `/auth/*` route contains no refresh token. Negative: no bundle in `apps/web/dist` contains a `localStorage`/`sessionStorage` write on an auth path — a build-output assertion, because this is exactly the mistake a later refactor makes quietly. Negative: an expired access token triggers exactly one refresh, not a loop. pr-env (1.1.3): axe clean and keyboard-complete on sign-in, sign-out and the OTP entry; the OTP field is reachable, labelled and submittable by keyboard alone.
**Verification:** against the deployed site, a full sign-in leaves no token in `localStorage` or `sessionStorage` (checked in the browser, not inferred); sign-out revokes the refresh token such that a captured cookie no longer refreshes; the a11y suite is green on the new routes.
**Flag:** `auth.webSignIn.enabled` — default off; with it off the site is exactly the brochure it is today. **DoD:** a patient can sign in and out on the real domain; no token is reachable from script; protected content never reaches the DOM unauthenticated; the new routes pass the a11y gate. **Rollback:** flip the flag off — sign-in disappears, the static site is unaffected. **Do NOT:** put any token in `localStorage` or `sessionStorage`; add a non-`HttpOnly` auth cookie; make the account pages server-rendered; hard-code a user-facing string; bypass `RequireAuth` for a "quick" preview page.

### TASK 2.3.1 — Notification abstraction: email-primary, per-user preferences, recorded delivery

**Milestone:** M2.3 · **Requirements:** §5 (notifications), C-02 · **Decisions:** **D-10**, ADR-0009 · **Risks:** **R-01** · **Depends on:** 2.2.3, 1.4.1 · **Blocks:** 2.3.2, 3.4.x (appointment reminders) · **Size:** M · **Cost:** £0.00 net-new — SES volume sits inside `03-cost-model.md`'s existing line ($0.05/$0.18/$0.30).
**Context.** D-10 makes email the primary channel and SMS the exception, and R-01 is the arithmetic behind it: §5 asks for ~150 SMS/month and C-02's £5 buys ~108. The register's mitigation has four parts, and the one that is easy to skip is the last: **"never silently drop a reminder."** That is a property of the abstraction, not of the SMS provider, so it is built here, before a provider exists — the same reason `sms.ts` (0.5.3) already assembles every guard and deliberately calls no provider at all.
**Files:** `services/api/src/notifications.ts` (new), `services/api/src/notification-templates.ts` (new), `services/api/src/notification-log.ts` (new), `packages/i18n/src/notifications/` (new), `services/api/src/patient-repository.ts`, `docs/runbooks/notifications.md` (new).
**Steps.** 1. `Notifier.send(recipient, template, vars)` chooses a channel by policy, not by caller: **email always**, SMS only for the templates explicitly marked `smsEligible`, which at the end of this task is exactly one — the 1-hour appointment reminder. 2. Templates live in the i18n catalogues and render through `t()`, so a notification is translatable the day D-04's trigger fires and no string escapes the lint rule. 3. Per-user channel preferences on the patient record's `personal{}` half (marketing consent is already there) — and a preference can silence *marketing*, never a clinical or safety notification. That distinction is stated in the runbook and asserted in a test. 4. **Degradation, defined here rather than discovered later:** when SMS is unavailable for any reason — capped, killed, rate-limited, not-UK, provider error — the notification falls back to email plus an in-app record and **writes a delivery record marked `degraded` with the reason**. There is no path that returns success without a record and no path that returns silence. 5. `notification-log.ts` appends a delivery record per attempt — recipient id, template, channel, outcome, reason — identifiers only, no message body, no clinical content, same discipline as the audit log. 6. Bounces and complaints from the existing SES configuration set (`email-events.ts`) mark a recipient's email unreachable so the next send degrades rather than repeating into a void. 7. Nothing schedules anything: this task builds the sender. The reminder *schedule* is 3.4.x's, and building it here would be guessing at an appointment model that does not exist. 8. Log group `/ndn/notification-function` → `UNMONITORED_LOG_GROUP_NAMES`.
**Interfaces:**

```ts
// services/api/src/notifications.ts
export type Channel = 'email' | 'sms' | 'in-app';
export type DeliveryOutcome = 'sent' | 'degraded' | 'failed';

export interface DeliveryRecord {
  readonly at: string;
  readonly recipientId: string;      // never an address
  readonly template: string;
  readonly channel: Channel;
  readonly outcome: DeliveryOutcome;
  readonly reason?: string;          // 'Capped' | 'Blocked' | 'NotUk' | 'RateLimited' | 'Bounced' | …
}
```

**Tests.** Unit: an `smsEligible` template with SMS capped sends email, records `degraded`, and names the reason — asserted for each of `Capped`, `Blocked`, `NotUk` and `RateLimited` separately, because R-01 is about the ones nobody notices. Unit: a non-eligible template never reaches the SMS path even with every flag on. Unit: a marketing preference of "none" silences marketing and does not silence a clinical notification. Unit: every template renders in `en` with no missing key, and a missing key fails rather than rendering a placeholder. Negative: **no code path returns success without appending a delivery record** — the test enumerates every branch. Negative: no delivery record contains an email address, a phone number or message content.
**Verification:** `pnpm test` green including the i18n lint rule; a manual send against the deployed SES identity produces one delivery record and one real email.
**Flag:** `notifications.enabled` — default off. **DoD:** every notification the platform can send goes through one function, is translatable, is recorded, and degrades loudly; SMS is reachable by exactly one template. **Rollback:** flip the flag off. **Do NOT:** call SES or the SMS sender directly from a handler; mark a second template `smsEligible` without re-doing R-01's arithmetic in the PR; let a user preference silence a clinical or safety notification; log a message body or an address.

### TASK 2.3.2 — SMS provider: re-verify UK prices, choose, wire behind 0.5.3's guards

**Milestone:** M2.3 · **Requirements:** C-02, NFR-09 · **Decisions:** **ADR-0008 (resolved by this task)**, D-11 · **Risks:** **R-01, R-02** · **Long-lead:** **LL-02** · **Depends on:** 2.3.1, 0.5.3, 0.5.1 · **Size:** M · **Cost:** £0.00 this month — no reminder exists to send until 3.4.x. Modelled at **$2.00 (M6) / $3.63 (M12)**, hard-capped at £5 = $6.05.
**Context.** ADR-0008 is the one ADR in the set that does not decide anything: "Provider chosen at M2.2 from re-verified UK prices; Twilio verified $0.056; AWS End User Messaging price **UNVERIFIED**." `09-self-audit.md` lists that price among the six deferred `UNVERIFIED` items, with re-verification due "at the gate that precedes its first real use." This is that task. `sms.ts` already assembles every guard — flags, +44 allow-list, per-principal rate limit, monthly spend cap — and its header states plainly that "there is no code path here, in a test or otherwise, that can send a real SMS." This task is the one that changes that sentence, and it is the highest-consequence line in the phase for C-02.
**Files:** `services/api/src/sms.ts`, `services/api/src/sms-provider.ts` (new), `docs/adr/0008-sms.md`, `docs/plan/03-cost-model.md`, `docs/plan/09-self-audit.md`, `docs/runbooks/sms-hard-cap.md`.
**Steps.** 1. **Re-verify both prices live before choosing** — AWS End User Messaging's UK rate from the pricing API or console, Twilio's from its published UK price — and record both, with the date and the method, in ADR-0008. A price found rather than assumed is the whole point of the deferral. 2. Choose on total cost including the sender-ID and registration overhead, not the per-message rate alone, and write the rejected option's number next to the chosen one. 3. `SmsProvider` as a one-method interface behind `createSmsSender`'s existing shape, so ADR-0008's "reversal cost: low — behind the notification abstraction" stays true and a provider swap touches one file. 4. **The provider is called only after every existing guard has passed**, in the order `sms.ts` already enforces; this task adds a call at the end of that chain and moves nothing. 5. The provider's own spend limit is set as the backstop D-11 requires — app-level cap *and* provider-level cap, because a bug in ours should still hit theirs. 6. Sender-ID registration and any UK onboarding is LL-02, owner-owned, 2–4+ weeks: **start it at the beginning of this task, not at the end.** 7. Prove the cap against the real provider in a sandbox: drive the counter to the cap and assert the next send is refused *before* the provider is called, with a delivery record marked `Capped` (2.3.1). 8. The anomalous-velocity alarm R-02 asks for is added to the existing budget/alarm stack. 9. Verify the +44 allow-list against the real provider's E.164 formatting, not only against our normaliser.
**Interfaces:**

```ts
// services/api/src/sms-provider.ts
export interface SmsProvider {
  send(to: string, body: string): Promise<{ readonly providerMessageId: string }>;
}
```

**Tests.** Unit: the provider is not called when any guard rejects — one test per guard: flag off, kill switch, non-UK, rate-limited, capped. Unit: a provider error yields `degraded`, not a thrown request, and is recorded. Integration (provider sandbox): a real send to a UK test number succeeds and returns a message id; a send to a non-UK number is refused by our allow-list before the provider ever sees it. Integration: at the cap, the next send is refused with the counter unchanged. Negative: no test, fixture or script can reach the provider without passing the full guard chain — asserted by a test that calls the chain with each guard failing in turn.
**Verification:** the cap is demonstrated against the real provider, not simulated; `03-cost-model.md`'s SMS line and `09-self-audit.md`'s `UNVERIFIED` list are updated with the verified rate; ADR-0008 names a provider.
**Flag:** `sms.enabled` — default off, with `sms.killSwitchEngaged` available as the independent stop. **DoD:** one provider is chosen on re-verified prices and recorded; a real SMS can be sent; the £5 hard cap is proven against the real provider; no send bypasses a guard. **Rollback:** `sms.enabled` off, or `sms.killSwitchEngaged` on — either stops sends with no deploy; the provider account's own spend limit stands behind both. **Do NOT:** call the provider from anywhere but `sms.ts`; raise the cap to make a test pass; send to a non-UK number; skip the provider-side spend limit because the app-side one exists; leave LL-02 to the end of the task.

### TASK 2.4.1 — Clinician accounts: invite, TOTP enrolment, principal and sub roles, deactivate-never-delete

**Milestone:** M2.4 · **Requirements:** §5 (clinician accounts), NFR-03 · **Decisions:** D-09 · **Risks:** R-09 · **Depends on:** 2.2.1, 2.2.2, 2.1.3, 2.3.1 · **Blocks:** 2.5.1, 2.5.3 · **Size:** M · **Cost:** £0.00
**Context.** The clinician directory, and the first place `04-data-model-rbac.md`'s "Clinician accounts: C R U (deactivate only), principal alone" row becomes real. Clinicians are never self-serve: the principal clinician creates them, which is why 2.2.1 disabled self sign-up on that pool at the directory level rather than trusting a check in a handler.
**Files:** `services/api/src/clinician-repository.ts` (new), `services/api/src/clinician-admin-handler.ts` (new), `packages/shared-types/src/clinician.ts` (new), `infra/src/data-stack.ts`, `docs/runbooks/clinician-accounts.md` (new).
**Steps.** 1. `CLI#<id>` / `PROFILE` with `role: 'principal' | 'sub'` and `active: boolean`, per the data model. 2. Creation is a principal-only route guarded by `can()`; it creates the Cognito user with `AdminCreateUser` (invite by email, temporary password) **and** the `CLI#` record in one operation, with the record written first so an orphaned Cognito user is the failure mode rather than an orphaned record. 3. TOTP enrolment is enforced by the pool (`mfa: REQUIRED`, 2.2.1) — Cognito will not complete the first sign-in without it, which is exactly why the two-pool decision was worth its cost. Nothing here re-implements it. 4. **Deactivation, never deletion:** `active: false` plus `AdminDisableUser`, plus a refresh-token revocation so a signed-in session ends now rather than in an hour. `AdminDeleteUser` is denied to the deploy role (2.2.1) and appears nowhere. 5. A deactivated clinician's *record* stays fully readable — their name still resolves on every past assignment, note and audit row, which is the reason never-delete exists here and not merely a policy echo. 6. Reactivation is the same route in reverse and is audited identically. 7. Exactly one `principal` may exist; a second is rejected at the repository, not the handler. Transferring the role is a distinct, audited operation, never an implicit side effect of creating someone. 8. Invite and deactivation emails go through 2.3.1's notifier. 9. Log group `/ndn/clinician-admin-function` → `UNMONITORED_LOG_GROUP_NAMES`.
**Interfaces:**

```ts
// packages/shared-types/src/clinician.ts
export interface Clinician extends BaseRecord {
  id: string;
  subjectId: string;          // Cognito sub in the clinician pool
  displayName: string;
  role: 'principal' | 'sub';
  active: boolean;
}
```

**Tests.** Unit: creating a second `principal` is rejected. Unit: deactivation sets `active: false`, disables the pool user and revokes tokens — all three asserted, since any one alone leaves a live session. Unit: a deactivated clinician's record is still readable by id. Integration: a sub-clinician calling the create route gets `403`; a patient gets `403`. Negative: no code path calls `AdminDeleteUser` — a repo-wide assertion in the same family as `lint:no-destructive`. Negative: a deactivated clinician's token is refused within the authorizer cache window and their name still renders on historical records.
**Verification:** against the deployed pool, an invited clinician cannot complete sign-in without enrolling TOTP; deactivating one ends their session; their name still resolves afterwards.
**Flag:** `clinicians.administration.enabled` — default off. **DoD:** the principal clinician can create, deactivate and reactivate clinicians; TOTP is unavoidable; no clinician can be deleted; history never loses a name. **Rollback:** flip the flag off; the directory is unchanged. **Do NOT:** call `AdminDeleteUser`; remove a `CLI#` record; allow self sign-up on the clinician pool; let a second principal exist; deactivate without revoking tokens.

### TASK 2.5.1 — Approval and first assignment, and GSI1

**Milestone:** M2.5 · **Requirements:** §5 (approval and assignment), §7 (GSI1 access patterns) · **Decisions:** D-07 · **Depends on:** 2.2.3, 2.4.1, 2.1.3 · **Blocks:** 2.5.2, 3.x (every clinical entity is scoped by assignment) · **Size:** M · **Cost:** £0.00 net-new — GSI1 write units inside the modelled DynamoDB line.
**Context.** The hinge of the whole authorisation model. A patient sits in `pending` until a clinician approves them, and `assigned_clinician_id` is what every relationship check in 2.1.1 tests against — so from this task onward "assigned" is a real fact about the data rather than a parameter in a unit test. **GSI1** (clinician → patients, and later the clinician calendar) lands here, subject to the same prove-it-first condition GSI3 carries in 2.5.3.
**Files:** `services/api/src/assignment-repository.ts` (new), `services/api/src/assignment-handler.ts` (new), `packages/shared-types/src/assignment.ts` (new), `infra/src/data-stack.ts`, `docs/adr/0002-database.md`, `docs/runbooks/patient-assignment.md` (new).
**Steps.** 1. `PAT#<id>` / `ASSIGNREQ#<ts>` with `pending | approved | declined`, per the data model — the request is its own row, so the decision has a record independent of the patient's current state. 2. Approval does three things atomically in one `TransactWriteItems`: sets the request `approved`, sets the patient's `account_status: 'approved'` and `assigned_clinician_id`, and writes the GSI1 projection. Partial application here would produce an approved patient nobody is responsible for. 3. Add **GSI1** (`gsi1pk = CLI#<id>`), sparse, with the access patterns written down and checked against the key schema first and recorded in ADR-0002 — same discipline as 2.5.3, and the calendar pattern GSI1 also has to serve in 3.4.x is included in that check now, while the index is still cheap to shape. 4. Decline sets the request `declined` and the patient `declined`. **Neither row is removed**, and a declined patient can be re-approved later — the record of the earlier decision stays. 5. Only the principal clinician assigns; a sub-clinician may approve only onto themselves, if the matrix allows it at all — this task settles that against `authz-matrix.ts` rather than inventing a rule, and if the matrix is silent, the answer is deny and the matrix gets an explicit cell. 6. Approval and decline notify the patient through 2.3.1, content-free. 7. Every transition writes an audit row with the acting principal. 8. Log group `/ndn/assignment-function` → `UNMONITORED_LOG_GROUP_NAMES`.
**Interfaces:**

```ts
// packages/shared-types/src/assignment.ts
export interface AssignmentRequest extends BaseRecord<'pending' | 'approved' | 'declined'> {
  patientId: string;
  requestedAt: string;
  decidedBy?: string;         // clinician subjectId
  decidedAt?: string;
  assignedClinicianId?: string;
}
```

**Tests.** Unit: approval is atomic — a forced failure on any leg leaves the patient `pending` with no GSI1 row, asserted per leg. Unit: a declined patient can be re-approved and both decisions survive. Integration: after approval, GSI1 returns the patient under the assigned clinician and under no other. Negative: an unassigned sub-clinician is denied on that patient's every route — the cross-tenant negative Gate G2 exists to demand, asserted route by route, not once. Negative: a patient cannot approve themselves, cannot assign, and cannot read another patient's assignment request. Negative: no path deletes a request row.
**Verification:** `aws dynamodb describe-table` shows GSI1; end-to-end, a registered patient is approved, appears under exactly one clinician, and is invisible to every other clinician.
**Flag:** `assignment.enabled` — default off; turned on together with `auth.patientRegistration.enabled`, since registration without approval strands people in `pending`. **DoD:** a patient moves `pending → approved` with an assigned clinician, atomically and audibly; GSI1 serves clinician→patients with its access patterns proven; every unassigned path is denied and tested. **Rollback:** flip the flag off — no further decisions can be made; existing assignments stand. **Do NOT:** set `assigned_clinician_id` outside the transaction; delete a request or a declined patient; let a sub-clinician assign to another clinician; skip the ADR-0002 access-pattern check because GSI1 "is obvious".

### TASK 2.5.2 — Reassignment, with an append-only assignment history

**Milestone:** M2.5 · **Requirements:** §5 (reassignment) · **Depends on:** 2.5.1, 2.1.3 · **Size:** S · **Cost:** £0.00
**Context.** Caseloads move: a clinician leaves, a patient's needs change, a deactivated clinician (2.4.1) leaves patients behind. Reassignment is where an authorisation model quietly breaks — the old clinician keeps access because nothing revoked it, or the history is overwritten and nobody can say who was responsible last March. Both are handled here, and neither is handled by editing a field.
**Files:** `services/api/src/assignment-repository.ts`, `services/api/src/assignment-handler.ts`, `docs/runbooks/patient-assignment.md`.
**Steps.** 1. Reassignment appends a new `ASSIGNREQ#<ts>` row and updates `assigned_clinician_id` in one transaction. **The previous row is never edited** — the history is the sequence of rows, so "who was assigned on a given date" is answerable forever. 2. The previous clinician's access ends the moment `assigned_clinician_id` changes, because `can()` reads the current value; the authorizer's 300-second cache is the only lag and the runbook states it rather than leaving it to be found. 3. GSI1 gains the new clinician's projection row. The old row is left in place and filtered by the current `assigned_clinician_id` on read — **not deleted**, because `DeleteItem` does not exist in this codebase; the read-side filter is the cost of that rule and is asserted in a test rather than assumed. 4. Bulk reassignment away from a deactivated clinician is one audited operation per patient, never a silent sweep — the audit log should read as a list of decisions. 5. Both clinicians and the patient are notified through 2.3.1. 6. A patient is never left with no clinician: reassignment requires a target, and there is no "unassign".
**Interfaces:** `POST /patients/{id}/reassign` — principal-clinician only.
**Tests.** Unit: reassignment appends and never mutates a prior row. Unit: assignment history reconstructs correctly across three consecutive assignments. Integration: after reassignment, GSI1 filtered by current assignment returns the patient under the new clinician only, despite the stale projection row still existing. Negative: the previous clinician is denied on every one of that patient's routes after the change. Negative: there is no request shape that results in a patient with no `assigned_clinician_id`.
**Verification:** end-to-end, a patient reassigned between two clinicians is visible to exactly one at every point, and the audit log names both decisions.
**Flag:** `assignment.enabled` — the same flag as 2.5.1; reassignment is not separately switchable. **DoD:** reassignment is atomic and audited, history is complete and append-only, the previous clinician's access ends, no patient is ever unassigned. **Rollback:** flip the flag off. **Do NOT:** edit or delete a prior assignment row; delete a stale GSI1 projection; allow an "unassign"; reassign in bulk without one audit row per patient.

### TASK 2.5.3 — Principal clinician's caseload view, and GSI3

**Milestone:** M2.5 · **Requirements:** **FR-DP-02** · **Decisions:** D-07 · **Depends on:** 2.4.1, 2.1.2, 2.5.1 · **Size:** M · **Cost:** £0.00 net-new — GSI3 adds write units on `PAT#`/`CLI#` writes only; inside `03-cost-model.md`'s DynamoDB line, and reconciled at G2 against real volume.
**Context.** FR-DP-02's cross-caseload admin view is the query `04-data-model-rbac.md` reserves **GSI3** for, and `09-self-audit.md`'s red-team names "admin cross-caseload views" as one of the two queries most likely to defeat the single-table design. 1.3.1 created GSI2 only and said the rest "land with the Phase 2/3 tasks that first need them." This is the task that first needs GSI3, and it must **prove the query against the key schema before writing the code** — ADR-0002's standing condition and the red-team's own mitigation.
**Files:** `infra/src/data-stack.ts`, `services/api/src/caseload-repository.ts` (new), `services/api/src/caseload-handler.ts` (new), `apps/web/src/pages/[locale]/account/caseload.astro` (new), `docs/adr/0002-database.md`.
**Steps.** 1. Write the access pattern down first — every read the principal's view performs, with its key condition and expected item count — and check it against the key schema on paper before any CDK change, recording the result in ADR-0002. If a pattern needs a `Scan`, the design is wrong and the ADR names the fallback rather than the code shipping a `Scan`. 2. Add **GSI3** as a sparse index projecting only what the list renders (`KEYS_ONLY` or a narrow `INCLUDE`) — a full projection doubles storage on the largest partition for a view nobody paginates deeply. 3. Sparse on purpose: only rows that belong in an admin view carry `gsi3pk`, so the index never has to be filtered down from everything. 4. Every read goes through 2.1.2's projection: the principal's matrix row is `R` on `private{}`, so it is one of the two roles that legitimately sees it — which makes this the first place the boundary is exercised in the *allow* direction, and the negative tests matter as much as the positive ones. 5. Paginate with `LastEvaluatedKey`; never accumulate a caseload in memory. 6. The page is a React island behind `RequireAuth` (2.2.4), keyboard-navigable, and axe-clean under 1.1.3. 7. Log group `/ndn/caseload-function` → `UNMONITORED_LOG_GROUP_NAMES`.
**Interfaces:** `GET /caseload?cursor=` — principal-clinician only, paginated.
**Tests.** Unit: every documented access pattern resolves to a `Query`, never a `Scan` — asserted by inspecting the command each repository method issues. Unit: pagination round-trips a cursor and never drops or repeats an item across pages. Integration: GSI3 returns only rows carrying `gsi3pk`. Negative: a sub-clinician and a patient each get `403`, and a sub-clinician cannot reach another clinician's caseload by any parameter. Negative: the response for a sub-clinician-scoped variant carries no `private{}` field. pr-env: the caseload page is axe-clean and keyboard-complete.
**Verification:** `aws dynamodb describe-table` shows GSI3 with the intended projection; the deployed endpoint returns a paginated caseload for the principal and `403` for everyone else; ADR-0002 records the proven access patterns.
**Flag:** `caseload.view.enabled` — default off. **DoD:** the principal clinician sees every patient across every caseload; the query is proven against the key schema and documented in ADR-0002; no `Scan` reaches the table; nobody else can call it. **Rollback:** flip the flag off. GSI3 stays — dropping an index is a table operation, not a revert. **Do NOT:** add a `Scan` "just for admin"; project the whole item into GSI3; create GSI4 speculatively while in the file; return an unpaginated caseload.

### TASK 2.5.4 — Retire the `ADMIN_API_TOKEN` bearer gate

**Milestone:** M2.5 · **Requirements:** NFR-03, NFR-06 · **Risks:** R-07 · **Depends on:** 2.2.2, 2.4.1 · **Size:** M · **Cost:** £0.00 — removes one SSM parameter and four grants.
**Context.** `services/api/src/admin-auth.ts` has said since 1.3.2 exactly what it is: "one narrow, explicitly-temporary bearer-token gate… no user identity, no session, no scopes — just 'did the caller present the one shared secret'… **Superseded by Phase 2's Cognito RBAC**." Four production endpoints stand behind it today — content authoring, workshop authoring, testimonial moderation and media upload. It is a single shared secret with no attribution: the audit log built in 2.1.3 records `actor` for every write, and for these four routes that actor is a token rather than a person. Phase 2 is the phase that promised to remove it, and a temporary gate that survives its own replacement is how a shared secret becomes permanent.
**Files:** the four `verifyAdminToken` call sites — `services/api/src/content-authoring.ts`, `media-upload.ts`, `testimonial-moderation.ts`, `workshop-authoring.ts` — and the four handlers that resolve the secret for them, `content-authoring-handler.ts`, `media-upload-handler.ts`, `testimonial-moderation-handler.ts`, `workshop-authoring-handler.ts`; `services/api/src/admin-auth.ts` (deleted); `infra/src/data-stack.ts`, `infra/src/web-stack.ts`, `infra/src/config.ts`; `docs/runbooks/content-authoring.md`, `docs/runbooks/testimonials.md`, `docs/runbooks/workshops.md`.
**Steps.** 1. Put all four routes behind 2.2.2's authorizer and `can()`, with clinician-role authorisation replacing "presented the secret". 2. Their audit rows now carry a real `subjectId` and `actorRole` instead of an anonymous actor — the reason this task belongs in the phase that built the audit log, not later. 3. Delete `admin-auth.ts` and its tests. Deleting *code* is not what C-03 prohibits; leaving a live shared-secret path in place because "delete" appears in the sentence would be a misreading. 4. Remove `ADMIN_TOKEN_PARAMETER_NAME` from all four functions’ environments and the four `ReadAdminApiToken` IAM statements — three in `data-stack.ts` (content authoring, testimonial moderation, workshop authoring), one in `web-stack.ts` (media upload, which lives next to `MediaBucket`). A fifth mention of the name exists in `contact-form-handler.ts` and is a comment only — correct its reference rather than deleting the SSM-caching reasoning around it. 5. The SSM parameter `/ndn/admin-api-token` is **deleted by the owner by hand after the deploy is verified**, not by CDK and not by this task's code — the same convention every other secret in `config.ts` follows for creation, applied to retirement. Until then it is inert: nothing reads it. 6. Update the three runbooks that document `curl -H "Authorization: Bearer $ADMIN_API_TOKEN"` so the documented procedure is the real one; a runbook describing a retired auth mechanism is a defect. 7. Sequencing matters: this lands **after** at least one clinician account exists (2.4.1) and has been proven to sign in, or the four endpoints become unreachable by anyone.
**Interfaces:** unchanged — same routes, same request and response shapes, different authentication.
**Tests.** Unit: each of the four handlers rejects a request with no principal, and accepts one with a clinician principal. Negative: a valid *bearer token* — the old mechanism — is now rejected on all four routes, asserted individually; this is the test that proves retirement rather than addition. Negative: a patient principal is rejected on all four. Negative: `grep` finds no reference to `ADMIN_API_TOKEN` or `admin-auth` in `services/` or `infra/` — a build-level assertion. Integration (synth): no function's environment carries `ADMIN_TOKEN_PARAMETER_NAME` and no role holds a `ReadAdminApiToken` statement. Regression: the four endpoints' existing behaviour tests still pass unchanged apart from how the caller authenticates.
**Verification:** against the deployed API, a clinician token succeeds on all four routes and the old bearer token gets `403` on all four; `aws iam simulate-principal-policy` shows no role can read `/ndn/admin-api-token`; the three runbooks describe the Cognito flow.
**Flag:** none — a route cannot have two authentication mechanisms behind a flag without the weaker one being reachable. This is a cutover, and it is small enough to revert. **DoD:** no shared-secret authentication path exists anywhere in the platform; all four admin endpoints authenticate a person; their audit rows name that person. **Rollback:** revert the branch — the bearer gate returns, and the SSM parameter must therefore not be deleted until the deploy has been verified in production (step 5's ordering is the rollback plan). **Do NOT:** delete `/ndn/admin-api-token` in the same change that removes its readers; leave `admin-auth.ts` in the tree "in case"; land this before a clinician can sign in; leave a runbook documenting the retired mechanism.

**Gate G2:** patients and clinicians authenticate; every role boundary in `04-data-model-rbac.md` is implemented and negatively tested; every change to a person or a record is durably audited; no shared secret authenticates a human. Gate-specific addition, per `06-gate-checklists.md`: **a negative test for every cross-tenant path** — patient→other patient, sub-clinician→unassigned patient, patient→`private{}`, and the retired bearer token against all four legacy admin routes.

## Phases 3–7 — milestone plans + task stubs

*(Elaborated to full §12 detail at each gate, per D-27. Phase 2 was elaborated at Gate G1 and is above; Phase 3 is elaborated at Gate G2, and so on.)*

| Phase | Milestones | Stub tasks | Notes |
|---|---|---|---|
| **3 — Clinical core** | M3.1 patient record · M3.2 diagnosis/care plan/private notes · M3.3 assessment forms · M3.4 appointments + reminders · M3.5 content + media · M3.6 messaging | ~18 | R-09's chokepoint now lands at 2.1.2; M3.2 wires the first real entity through it. M3.1 starts from the `PAT#`/`PROFILE` record 2.2.3 creates, not from nothing |
| **4 — Video** | M4.1 signalling · M4.2 server-side call authz · M4.3 peer connection + device check + fallback · M4.4 TURN + caps · M4.5 join-button state machine | ~12 | R-03 mitigations in M4.4 |
| **5 — Hardening & launch** | M5.1 load test 10× · M5.2 security review · M5.3 a11y audit · M5.4 **restore drill executed** · M5.5 runbooks + cost reconciliation | ~10 | G5 = WEB IS DONE |
| **6 — Mobile** | M6.1–M6.7 | ~14 | Only after G5; additive versioned API changes only |
| **7 — Post-launch** | Analytics within privacy constraints, cost review, deferred backlog **incl. chatbot (D-05) if solicitor clears scope** | — | |
