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
**Context.** The highest-risk task in Phase 1 — the actual DNS cutover away from the legacy site and the final decommission of the R-06 public-delete-capable Lambda that TASK 0.0.2 only *contained*, never removed ("Do NOT delete the Lambda yet — that is task 1.6.1 at cutover"). D-25 held the legacy site untouched until this exact point; D-02 executes here. Two legacy surfaces must not be conflated: the Route 53 zone and the `nourishthenerve-api` Lambda/S3 bucket live in `803129122420`, but the CloudFront distribution currently serving apex/`www` (`d2z3fclxq13w3z.cloudfront.net`, confirmed live at Gate G0) is in a **third, unidentified account this project has never held credentials for**. This task can only ever repoint DNS away from that distribution — never touch it — and can only decommission the Lambda/bucket in `803129122420`.
**Files:** `docs/runbooks/g1-cutover.md` (new), `infra/src/config.ts`, `infra/src/web-stack.ts` (`domainNames`), `docs/plan/03-cost-model.md` (post-cutover reconciliation).
**Steps.** 1. **Pre-flight, no DNS/account changes:** confirm every Phase 1 task (1.1.1–1.5.2) is deployed and green at `next.nourishthenerve.com`, including a full a11y/keyboard pass (1.1.3) and a Core Web Vitals check (Gate G1's own criterion). 2. **Certificate:** request/extend an ACM cert in `us-east-1` covering `nourishthenerve.com` + `www.nourishthenerve.com` (keep `next.` too), DNS-validated via a manual CNAME in the `803129122420` zone (`Z09601252VHSWVDDK2RH4`) — same cross-account manual step 0.4.1 used. 3. **CloudFront:** add `nourishthenerve.com`/`www.nourishthenerve.com` as alternate domain names on the **existing** `NdnWebStack` distribution (not a second one — reuses the already-proven canary/rollback/security-headers/OAC shape), deployed via the ordinary CI `deploy` job (OIDC, `ndn-deploy`) — DNS-invisible so far. 4. **DNS cutover, last, one record type at a time:** in the `803129122420` zone (manual, `default` profile — `ndn-deploy` has no access there), repoint the apex `A`/`ALIAS` and `www` `CNAME`/`ALIAS` from `d2z3fclxq13w3z.cloudfront.net` to `NdnWebStack`'s distribution. Lower the TTL beforehand if currently high, so rollback propagates fast. 5. **Verify immediately:** `curl -sI` both apex and `www` serve the new site (200, expected headers, `/health` version); watch the 0.6.2 canary/smoke-test machinery on this deploy specifically — its first time serving the apex. 6. **Observe before decommissioning:** for 24–48h, monitor `nourishthenerve-api`'s CloudWatch invocation metrics (`803129122420`) to confirm invocations drop to zero (excluding this task's own probes). 7. **Decommission, `803129122420` only, manual:** delete the Function URL first, then the Lambda function itself (satisfies D-02). **Leave the S3 bucket `nourishthenerve` exactly as 0.0.2 configured it** — versioned, read-only, `clients/`/`posts/` untouched; D-03 forbids any code or task here from deleting it. 8. Update `03-cost-model.md`'s reconciliation note with actual vs. modelled M1 spend, per Gate G1's checklist. 9. Before step 7, fix or formally accept the two pre-existing legacy issues `legacy-estate.md` flagged and this gate re-confirmed still live: the unauthenticated `/client/{id}/report` enumeration exposure and the broken `/form` route — decommissioning the Lambda resolves both by removal, but if step 7 is delayed for any reason past this task's completion, that exposure remains live and should be called out, not silently carried forward again.
**Interfaces:** none (infrastructure/DNS task).
**Tests.** Integration: post-cutover, both apex and `www` serve `NdnWebStack` content over TLS with the expected security headers (same assertions 0.4.1 runs against `next.`). Integration: the canary/auto-rollback machinery is exercised for real on this deploy. Regression: every Phase 1 feature verified against the apex domain specifically, not only `next.` (a same-origin/absolute-URL assumption would otherwise surface only now). Negative: after step 7, invoking the deleted legacy Function URL fails, and `aws lambda get-function --function-name nourishthenerve-api` returns `ResourceNotFoundException`. Negative: the S3 bucket's objects remain read-only accessible exactly as 0.0.2 left them — proving the Lambda decommission left the data untouched.
**Verification:** `dig` on both apex and `www` resolve to `NdnWebStack`'s distribution; `curl -sI` both return 200 with the full security-header set; a Core Web Vitals run against the live apex passes Gate G1's bar.
**Flag:** none — this is a DNS cutover, not application behaviour; every feature flag it depends on should already be flipped on and proven in staging before this task runs, not flipped as part of it.
**DoD:** apex and `www` serve the new site exclusively; `nourishthenerve-api` and its Function URL no longer exist in `803129122420`; legacy invocation metrics show zero real post-cutover traffic; Gate G1's checklist (apex serving new site, legacy retired, Core Web Vitals pass) is met and recorded.
**Rollback:** **DNS-only, fast, rehearsed before use:** revert the apex/`www` records in `803129122420` to `d2z3fclxq13w3z.cloudfront.net` (documented ahead of time, not guessed) — restores the legacy experience with zero AWS resource changes, provided step 7 hasn't run. **Once step 7 has run, the Lambda cannot be undeleted** — this is why the observation window and step ordering (DNS first, confirmed stable, *then* delete) exist. A post-step-7 issue is fixed forward on the new stack or rolled back via DNS to legacy CloudFront (untouched throughout), never by resurrecting the deleted Lambda.
**Do NOT:** delete the legacy Lambda, Function URL, or IAM policy before DNS has served the new site through the full observation window; touch anything in the unidentified third account serving the legacy CloudFront distribution; delete, empty, or version-purge the S3 bucket `nourishthenerve` or its prefixes under any circumstance (D-03); skip the TTL-lowering step; run this task before every Phase 1 dependency is proven at `next.nourishthenerve.com` first.

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
