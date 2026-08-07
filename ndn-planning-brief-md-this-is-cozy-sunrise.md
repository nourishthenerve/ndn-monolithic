# Nourish the Nerve — Neuro-Rehab Platform: Execution Plan

## Context

Nourish the Nerve is a UK neuro-rehabilitation clinic that today has only a static brochure site. It needs a real platform: patients register, are approved and assigned to a clinician, then access their diagnosis, care plan, appointment calendar, clinician-assigned educational content and 1:1 video consultations. Clinicians run assessments during those calls; a principal clinician oversees the whole caseload. A public site carries blogs, paid workshops, testimonials and a contact route.

Three constraints shape every decision below: **£20/month all-in ex-VAT** (designed to £12–14), **zero downtime with no staging environment**, and an absolute prohibition on code that deletes patient, clinical, content or media data. This plan was produced under the two-stage protocol in `ndn-planning-brief.md` — Stage A discovery is at the end of this document as an appendix; Stage B is everything above it.

**Verified position (2026-08-07):** greenfield repo (zero commits), domain and DNS under our control in AWS account 803129122420, live brochure site served from a *different* unidentified AWS account, and a legacy click-ops Lambda with a public unauthenticated URL holding delete rights over an unversioned bucket. Planning FX £1 = $1.2105 ($1.345 ECB less the 10% adverse buffer required by C-01).

---

## 1. Decision log

Decisions D-01…D-05 were answered directly. D-06 onward are the Stage A recommended defaults, adopted so work can proceed — **each is individually overridable and none is load-bearing on the others unless noted.**

| ID | Decision | Consequence |
|---|---|---|
| **D-01** | Build in a **new AWS member account** inside an Organization under the existing payer | Existing card, one consolidated invoice, access by role-switch, one new root email with MFA then unused. Gains **its own always-free allowances** (islamicmaps currently consumes 803129122420's). No signup credits (org members forfeit them). **SES production access must be requested in the new account** → long-lead, Phase 0 |
| **D-02** | Legacy `nourishthenerve-api` Lambda is **decommissioned**; build is greenfield | No port, no reuse. Live brochure site may call it, so removal happens at G1 cutover. Interim non-destructive containment still lands in Phase 0 |
| **D-03** | `clients/` (361 MB) is **disposable test/demo material** | Excluded from the new platform. **No code we write will delete it** (§6.8 — erasure stays a manual human action). Versioning still enabled as cheap insurance; you remove it by hand if you want it gone |
| **D-04** | **English at launch**, i18n framework built for N languages, **RTL-safe primitives from day one** | No hard-coded copy anywhere, ever. Translation procurement is a long-lead item triggered when you name languages; it does not block launch |
| **D-05** | **Chatbot deferred past launch** | FR-WEB-03 and M1.6 leave launch scope. LLM spend line = £0. Medical-device qualification leaves the critical path but **stays open** in the risk register |
| D-06 | Serverless-first: Lambda **arm64** + API Gateway **HTTP API** | arm64 is 20% cheaper/GB-s; HTTP API ~⅓ the price of REST |
| D-07 | **DynamoDB on-demand**, single-table design | 25 GB always-free; every §7 query proven servable in ADR-004 or we switch and cost an instance honestly |
| D-08 | Static web on **S3 + CloudFront PriceClass_100**, API on same domain | Same-origin cookies/CORS; 1,000 free invalidations/month covers deploys |
| D-09 | **Cognito Essentials** — TOTP for clinicians, email-OTP for patients | £0 at our scale (10,000 free MAU verified); email-OTP requires Essentials; avoids self-rolled auth on health data |
| D-10 | **Email-primary notifications** via SES; SMS only for the 1-hour appointment reminder | Arithmetic, not preference — see Risk R-01 |
| D-11 | SMS: app-level hard block + provider spend limit backstop + **+44 allow-list** + per-principal rate limit | C-02 demands a block, not an alert |
| D-12 | Video: **P2P first, Cloudflare TURN fallback** (1 TB/mo free), concurrency-capped | Verified worst case ≈80–90 GB/mo. Self-hosted coturn ≈£6/mo — rejected on cost |
| D-13 | **Stripe Checkout**, GBP, webhook-driven, idempotent | No monthly fee; per-transaction fees netted from revenue, outside C-01 |
| D-14 | **SSM Parameter Store SecureString** for secrets, not Secrets Manager | Secrets Manager at ~6 secrets ≈ £2/mo = 15% of target envelope for no benefit we need |
| D-15 | **AWS CDK (TypeScript)** for all infrastructure | One language across web, API, IaC, mobile (NFR-08) |
| D-16 | **TypeScript end-to-end**, pnpm workspaces monorepo | Single toolchain; shared types are the contract |
| D-17 | GitHub Actions with **OIDC federation** to a deploy role; no long-lived AWS keys | NFR-03; constrained to 2,000 free CI minutes/month |
| D-18 | Observability: UptimeRobot free + ~8 CloudWatch alarms + **14-day log retention**, no dashboards/WAF/Synthetics | Log ingestion at $0.5985/GB is the sleeper cost |
| D-19 | Pre-production confidence: local emulation + **ephemeral per-PR environments** + contract tests + **feature flags** + canary alias + post-deploy smoke with auto-rollback | Standing cost £0 — the answer to §10 |
| D-20 | **SLO 99.9%/month**, measured by 5-minute external checks + post-deploy smoke | 43 min/month budget. Stated honestly: 5-min polling detects outages, it cannot *prove* 99.9% |
| D-21 | **RPO ≤1h** (DynamoDB PITR), **RTO ≤4 working hours**, restore drill actually executed at M5.4 | PITR on a sub-1 GB clinical dataset costs pennies |
| D-22 | Backups: PITR **plus** periodic export to a separate object-locked prefix | §6.6 wants protection from account compromise, not just bad code |
| D-23 | Feature flags: **homegrown, config-driven** | Avoids a recurring SaaS line item |
| D-24 | Add the **missing DMARC record**; keep Zoho Mail EU for inbound | Deliverability is a launch blocker under an email-primary strategy |
| D-25 | Legacy brochure site stays live untouched until **G1 DNS cutover** | We hold DNS; we never need the other account |
| D-26 | Mobile: **Expo / React Native**, not before G5 | C-10. Store fees ($99/yr + $25) reported, outside C-01 |
| D-27 | **§0.6 elaboration policy adopted as written** | Full detail Phases 0–1; stubs beyond; elaborated at each gate |
| D-28 | **Root access keys deleted by you** once an admin identity exists | I flag it; I will not touch credentials |

---

## 2. Risk register

| ID | Risk | L | I | Mitigation | Task |
|---|---|---|---|---|---|
| **R-01** | **§5 asks for ~150 SMS/month; C-02's £5 buys ~108.** Reminder volume at 500 patients exceeds the cap | High | High | Email-primary (D-10); SMS reserved for the 1-hour reminder; defined degradation to email+in-app when capped; push notifications in Phase 6 relieve it permanently. **Never silently drop a reminder** | 0.5.3, 3.4.4 |
| **R-02** | **SMS pumping fraud** (NFR-09) burns the month's budget in minutes | Med | High | +44-only destination allow-list, per-principal rate limit, hard block at cap, anomalous-velocity alarm, SMS only behind authentication | 0.5.3, 0.5.4 |
| **R-03** | **TURN relay cost blow-out** (FR-VID-04) | Low | High | Cloudflare free tier covers ~11× worst case; concurrent-relay cap; egress telemetry + alarm; kill switch degrades to audio-only | 4.4.1, 4.4.2 |
| **R-04** | **GDPR erasure vs C-03 never-delete** | High | High | **Unresolved by design** — goes to your DPO/solicitor. Schema separates clinical (retention basis) from non-clinical PII so a future human-authorised field-level erasure needs no rewrite | 0.3.4, LL-06 |
| **R-05** | **Chatbot medical-device qualification** (FR-WEB-03) | Med | High | Deferred by D-05, **not resolved**. Reopens only after solicitor sign-off on scope | LL-07 |
| **R-06** | Public unauthenticated Lambda with delete rights over unversioned bucket | High | High | Phase 0 containment: strip Delete/Put, enable versioning, remove public URL; full decommission at G1 | 0.0.2 |
| **R-07** | Root access keys in use for CLI | High | High | IAM Identity Center + OIDC deploy role; you delete root keys | 0.1.1, D-28 |
| **R-08** | Merge to master deploys straight to production (C-06) | High | High | CI is the only gate: contract tests, ephemeral PR envs, canary alias, smoke test, auto-rollback | 0.6.x |
| **R-09** | Clinician-private data leaks to a patient (FR-DP-05) | Med | Critical | Field-level projection at the repository layer, not the handler; 100% coverage on the boundary; negative test per endpoint, forever | 3.2.x |
| **R-10** | Cold starts breach p95 < 500ms (NFR-05) | Med | Med | arm64, small bundles, no VPC on request path; measured at M5.1. If missed, provisioned-concurrency cost shown to you rather than absorbed | 5.1.2 |
| **R-11** | Log ingestion at $0.5985/GB silently eats the envelope | Med | Med | 14-day retention, sampled request logs, no debug logging in prod, log-volume alarm | 0.5.2 |
| **R-12** | SES stuck in sandbox at launch | Med | High | Production-access case raised in **Phase 0**, before it can block | LL-01 |
| **R-13** | CI exceeds 2,000 free GitHub minutes | Med | Low | Path-filtered workflows, cached installs, minute-usage check at each gate | 0.2.4 |
| **R-14** | Data residency vs global CDN edges (NFR-04) | Low | Med | PriceClass_100; static assets only at edge; **no patient data traverses CloudFront** — API responses are no-store | ADR-003 |

---

## 3. Architecture Decision Records

Each ADR is one page in `docs/adr/`. Summarised here; monthly cost at §5 load.

| ADR | Decision | Options rejected | £/mo | Reversal cost |
|---|---|---|---|---|
| 001 Compute | Lambda arm64 + HTTP API | Always-on t4g.small (~£12, fails cap + no zero-downtime story); Fargate (~£25) | ~£0.48 | Low — handlers are framework-light |
| 002 Database | DynamoDB on-demand, single-table | RDS Postgres t4g.micro (~£11 + storage — over half the envelope); Aurora Serverless v2 (min ACU cost) | ~£0.75 | **High** — data model is the hardest thing to reverse. Mitigated by proving every §7 query in the ADR before code |
| 003 Web delivery | S3 + CloudFront PriceClass_100, API same-origin | Amplify Hosting (less control, more cost); S3 website endpoint (no TLS) | £0 (free tier) | Low |
| 004 Auth | Cognito Essentials | Self-rolled (security risk on health data — stated plainly); Auth0/Clerk (paid tiers) | £0 | High — user migration is painful |
| 005 Media storage | S3 + CloudFront signed URLs, versioning on | Public bucket (unacceptable); Lambda proxy (cost per byte) | ~£0.40 | Low |
| 006 Video transport | WebRTC P2P + Cloudflare TURN | Self-hosted coturn (~£6/mo, ~half the envelope); Twilio NTS ($0.40/GB); Daily/Vonage SDK (per-minute) | £0 | Medium |
| 007 Signalling | API Gateway WebSocket + DynamoDB connection table | Self-hosted socket server (always-on cost) | ~£0.10 | Low |
| 008 SMS | Provider chosen at M2.2 from re-verified UK prices; Twilio verified $0.056 | AWS End User Messaging (price UNVERIFIED — re-verify first) | ≤£5 hard cap | Low — behind the notification abstraction |
| 009 Email | SES eu-west-2 outbound; Zoho EU inbound; SPF+DKIM+**DMARC** | Postmark/SendGrid (monthly minimums) | ~£0.25 | Low |
| 010 Payments | Stripe Checkout, webhook-driven, idempotent | Direct card handling (never); PayPal | £0 recurring | Low |
| 011 Chatbot | **Deferred (D-05)** | — | £0 | N/A |
| 012 i18n | Catalogue-based, ICU messages, RTL-safe logical CSS | Runtime MT (cost + clinical accuracy risk) | £0 | Low if done now, **high if retrofitted** |
| 013 Mobile | Expo / React Native sharing api-client, types, i18n | Native ×2 (double cost); PWA-only (no push) | £0 (fees outside C-01) | Medium |
| 014 CI/CD | GitHub Actions + OIDC, ephemeral PR envs, canary + auto-rollback | CodePipeline (per-pipeline cost); manual deploy (fails C-06/C-07) | £0 | Low |
| 015 Observability | CloudWatch alarms + 14-day logs + UptimeRobot | Datadog/Grafana Cloud (exceed envelope alone) | ~£1.70 | Low |
| 016 Secrets | SSM Parameter Store SecureString | Secrets Manager (~£2/mo at 6 secrets) | £0 | Low |

---

## 4. Costed bill of materials

Planning rate **£1 = $1.2105**. All figures ex-VAT. New account ⇒ its own always-free allowances; **no 12-month new-account offers** (org members forfeit credits), so nothing below depends on an expiring trial.

| Line | M1 (site only) | M6 (~250 patients) | M12 (~500 patients) | Basis |
|---|---|---|---|---|
| Route 53 hosted zone | $0.50 | $0.50 | $0.50 | $0.50/zone |
| Route 53 queries | $0.02 | $0.03 | $0.04 | ~100k/mo @ $0.40/M |
| Domain renewal (amortised) | $1.17 | $1.17 | $1.17 | ~$14/yr ÷ 12 — **UNVERIFIED** |
| ACM certificates | $0 | $0 | $0 | Public certs free |
| CloudFront | $0 | $0 | $0 | Within always-free 1 TB + 10M req |
| S3 storage + requests | $0.10 | $0.30 | $0.53 | 20 GB @ $0.024 + requests |
| Lambda | $0 | $0 | $0 | Within always-free 1M req + 400k GB-s |
| API Gateway HTTP API | $0.12 | $0.35 | $0.58 | 500k req @ $1.16/M |
| DynamoDB on-demand | $0.05 | $0.40 | $0.67 | 2M RRU + 500k WRU |
| DynamoDB PITR | $0 | $0.12 | $0.24 | ~1 GB @ $0.23772 |
| Cognito Essentials | $0 | $0 | $0 | 509 MAU ≪ 10,000 free |
| SES outbound | $0.05 | $0.18 | $0.30 | 3,000 emails @ $0.10/1k |
| **SMS** | $0 | $2.00 | **$3.63** | Hard-capped at £5 = $6.05 |
| CloudWatch alarms | $0.80 | $0.80 | $0.80 | 8 × $0.10 |
| CloudWatch logs | $0.30 | $0.80 | $1.23 | ~2 GB @ $0.5985 + 14-day storage |
| KMS / Secrets Manager | $0 | $0 | $0 | SSE-S3 + AWS-owned keys + Parameter Store |
| EventBridge / SQS / Budgets | $0 | $0 | $0 | Within free allowances (≤2 budgets) |
| Cloudflare TURN | $0 | $0 | $0 | ≈85 GB ≪ 1,000 GB free |
| UptimeRobot / Turnstile / GitHub | $0 | $0 | $0 | Free tiers |
| **Total USD** | **$3.11** | **$6.65** | **$9.69** | |
| **Total GBP** | **£2.57** | **£5.49** | **£8.00** | |

**Headroom against the £12–14 target: £4–6/month. Against the £20 cap: £12/month.**
**After free tiers expire:** unchanged — every allowance relied on is *always-free*, not a 12-month offer. The only expiry risk is a future AWS pricing change, re-verified at each gate (§14.12).
Excluded per C-01: Stripe per-transaction fees (netted from workshop revenue); Apple $99/yr and Google $25 one-off (reported, Phase 6).

---

## 5. Data model + RBAC

**Single DynamoDB table**, PK/SK overloaded, GSIs for the access patterns §7 requires.

| Entity | Key shape | Notes |
|---|---|---|
| Patient | `PAT#<id>` / `PROFILE` | `account_status`, `record_status`, `assigned_clinician_id`, `keywords[]` |
| Clinician | `CLI#<id>` / `PROFILE` | `role: principal\|sub`, `active` |
| Assignment request | `PAT#<id>` / `ASSIGNREQ#<ts>` | `pending\|approved\|declined` |
| Diagnosis / Care plan | `PAT#<id>` / `DIAG#<v>`, `PLAN#<v>` | **Versioned, append-only** |
| Assessment form | `PAT#<id>` / `ASSESS#<id>#v<n>` | `visible{}` and `private{}` as separate attributes |
| Appointment | `PAT#<id>` / `APPT#<iso-utc>` | GSI1 = clinician calendar |
| Content item | `CONTENT#<id>` / `META` | Blog/audio/video/text/image, per-language |
| Assignment of content | `PAT#<id>` / `CONTENT#<id>` | |
| Message | `PAT#<id>` / `MSG#<ts>` | Patient↔clinician, rate-limited |
| Audit event | `AUDIT#<date>` / `<ts>#<id>` | **Append-only**, who/what/when/where |

GSIs: **GSI1** clinician→patients & calendar · **GSI2** keyword→content (FR-PP-10) · **GSI3** admin cross-caseload views (FR-DP-02) · **GSI4** appointment-window lookups for reminders.

**RBAC matrix** (C=create R=read U=update D=**never**, — = denied):

| Entity | Patient (own) | Patient (other) | Sub-clinician (assigned) | Sub-clinician (unassigned) | Principal |
|---|---|---|---|---|---|
| Own profile | R U | — | R U | — | R U |
| Patient profile | R U (self) | — | R U | — | R U |
| Diagnosis / care plan | **R** | — | C R U | — | C R U |
| Assessment — `visible{}` | R | — | C R U | — | R |
| **Assessment — `private{}`** | **—** | **—** | C R U | **—** | R |
| Appointments | R | — | C R U | — | R |
| Content assignment | R | — | C R U | — | R |
| Messages | C R (own thread) | — | R (own patients) | — | R |
| Clinician accounts | — | — | — | — | C R U (deactivate only) |
| Audit log | — | — | — | — | R |

**The clinician-private boundary is enforced at the repository layer** — a projection function strips `private{}` before data can reach any patient-facing serialiser. Not in the handler, not in the view: one chokepoint, 100% test coverage, negative test per endpoint forever (NFR-06).

---

## 6. Executor pack — `docs/plan/00-conventions.md`

**Before any task, the executor reads:** C-01–C-11, §6 of the brief, and this conventions file.

- **Stack:** TypeScript 5.x, Node 22 (arm64 Lambda), pnpm workspaces, CDK v2, Vitest, Playwright, Zod for runtime validation at every boundary.
- **Layout:** per §4 of the brief — `/apps/web`, `/apps/mobile`, `/packages/{api-client,shared-types,i18n,ui}`, `/services/{api,workers}`, `/infra`, `/tests/{integration,e2e,load}`, `/docs`.
- **Sizes:** S ≤ ~150 changed lines · M ≤ ~400 · **L = split it.**
- **Errors:** typed `AppError` with a stable `code`; never leak internals to responses; never log PII or clinical content — log identifiers only.
- **Logging:** structured JSON, one line per request, sampled. No `console.log`. No debug level in production.
- **Naming:** branches `feat/<milestone-id>-<slug>`; conventional commits; one task = one PR.
- **PR body must contain:** task ID, requirement IDs, what changed, test evidence (names + pass output), rollback steps, expected £ cost delta.
- **Time:** every timestamp stored as UTC instant; render Europe/London; **time is injectable — no test reads the wall clock.**
- **The prohibition:** no `DeleteItem`, `DeleteObject`, `TRUNCATE`, `DROP`, or destructive migration against protected stores — in application code, admin tools, scripts or test helpers. Soft-delete flags only.

---

## 7. Execution plan

### Phase 0 — Foundations (nothing user-facing)

#### TASK 0.0.1 — Commit the plan
**Milestone:** M0.0 · **Requirements:** — · **Decisions:** D-01…D-28 · **Depends on:** none · **Blocks:** all · **Size:** S · **Cost:** £0.00
**Context.** The plan must be versioned and reviewed like code before any of it is executed.
**Files:** create `docs/plan/00-index.md`, `00-conventions.md`, `01-decisions.md`, `02-risk-register.md`, `03-cost-model.md`, `04-data-model-rbac.md`, `05-execution-plan.md`, `06-gate-checklists.md`, `07-traceability.md`, `08-long-lead.md`, `09-self-audit.md`, `docs/adr/0001..0016-*.md`, `docs/compliance/dpia-skeleton.md`.
**Steps.** 1. `git init` state already exists; create branch `docs/0-0-1-commit-plan`. 2. Write each manifest document verbatim from this plan. 3. Open PR.
**Tests.** Markdown lint + link check in CI (added by 0.2.1; until then, manual link check documented in the PR).
**Verification:** `pnpm docs:lint` (once CI exists) · reviewer confirms every §0.5 file present.
**Flag:** none. **DoD:** all manifest files present; PR opened on a feature branch with the required body. **Rollback:** revert the commit. **Do NOT:** write application code.

#### TASK 0.0.2 — Contain the legacy public delete path
**Milestone:** M0.0 · **Requirements:** C-03, C-11, §6.7 · **Decisions:** D-02, D-03 · **Risks:** R-06 · **Depends on:** 0.0.1 · **Blocks:** 0.3.x · **Size:** S · **Cost:** £0.00
**Context.** A publicly invokable Lambda in account 803129122420 holds `s3:DeleteObject` over an unversioned bucket. Every data-protection guard we build later is theatre while this exists. This task is **non-destructive**: it removes capability and adds recoverability, and deletes nothing.
**Steps.** 1. Enable **versioning** on bucket `nourishthenerve` (eu-west-2). 2. Replace `LambdaS3AccessPolicy` with a read-only statement (`s3:GetObject`, `s3:ListBucket`) — **remove `PutObject` and `DeleteObject`**. 3. Delete the Function URL (`AuthType: NONE`) after confirming whether the live brochure site calls it; if it does, keep the URL until G1 and instead restrict CORS to the site origin. 4. Record findings in `docs/runbooks/legacy-estate.md`.
**Interfaces:** IAM policy document; S3 versioning configuration.
**Tests.** Integration: assert the role can `GetObject` and **cannot** `PutObject`/`DeleteObject` (IAM policy simulator, asserted in CI). Negative: unauthenticated call to the Function URL fails or is gone. Regression: brochure site still renders (synthetic fetch of `/` returns 200).
**Verification:** `aws s3api get-bucket-versioning --bucket nourishthenerve` → `Enabled`; `aws iam simulate-principal-policy` returns `implicitDeny` for `s3:DeleteObject`.
**Flag:** none (infrastructure). **DoD:** versioning on; delete/put denied; documented; cost delta £0. **Rollback:** re-attach the previous policy version (versioning stays — it is never harmful). **Do NOT:** delete any object, the bucket, or the `clients/` prefix. **Do NOT** delete the Lambda yet — that is task 1.6.1 at cutover.

#### TASK 0.1.1 — Provision the AWS account and identity baseline
**Milestone:** M0.1 · **Requirements:** NFR-03 · **Decisions:** D-01, D-28 · **Risks:** R-07 · **Depends on:** 0.0.1 · **Size:** M · **Cost:** £0.00
**Context.** All subsequent infrastructure lands in a dedicated member account with no human long-lived credentials.
**Steps.** 1. Create the Organization (if absent) in 803129122420; create member account `ndn-prod` with a unique root email; enable MFA on its root user and stop using it. 2. Enable IAM Identity Center; create `NDNAdmin` permission set. 3. Create the GitHub OIDC provider and `ndn-deploy` role with a trust policy scoped to `repo:nourishthenerve/ndn-monolithic:ref:refs/heads/main` **and** pull-request contexts for ephemeral envs. 4. Enable CloudTrail (management events, free tier) and Cost Explorer. 5. Document root-key deletion as **your** action.
**Tests.** Integration: assume `ndn-deploy` from a CI dry-run and confirm it can `cloudformation:DescribeStacks` and **cannot** `iam:CreateUser`. Negative: OIDC trust rejects a token from another repository.
**Verification:** `aws sts get-caller-identity` from CI shows the assumed role, not a user.
**DoD:** no IAM users with access keys exist in the new account. **Rollback:** delete the role; the account remains harmless and free.
**Do NOT:** copy root access keys anywhere. **Do NOT** delete the existing account's keys yourself — that is the owner's action.

#### TASK 0.1.2 — Monorepo scaffolding, linting, formatting, type checking
**Milestone:** M0.1 · **Requirements:** NFR-08 · **Decisions:** D-15, D-16 · **Depends on:** 0.0.1 · **Size:** M · **Cost:** £0.00
**Files:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `.prettierrc`, `vitest.config.ts`, plus empty workspace packages per §4.
**Steps.** 1. pnpm workspaces with the §4 layout. 2. Strict TS (`strict`, `noUncheckedIndexedAccess`). 3. ESLint + Prettier + import ordering. 4. Vitest with coverage thresholds configured but not yet enforced (0.2.3 enforces).
**Tests.** Unit: one trivial test per package proving the harness runs. **Verification:** `pnpm -r lint && pnpm -r typecheck && pnpm -r test`.
**DoD:** clean run on a fresh clone. **Rollback:** revert. **Do NOT:** add runtime dependencies not needed by a shipped feature.

#### TASK 0.2.1 — CI pipeline with quality gates
**Milestone:** M0.2 · **Requirements:** C-06, C-09, NFR-03, NFR-06 · **Risks:** R-08, R-13 · **Depends on:** 0.1.1, 0.1.2 · **Size:** M · **Cost:** £0.00
**Steps.** 1. `.github/workflows/ci.yml`: install (cached) → lint → typecheck → unit → integration → coverage thresholds → dependency audit → secret scan. 2. Path filters so docs-only PRs skip heavy jobs (protects the 2,000-minute budget). 3. Branch protection requiring CI green. 4. Job summary prints CI minutes used.
**Tests.** Meta: a deliberately failing lint rule on a scratch branch fails the build (evidence in PR).
**Verification:** `gh run list` shows required checks. **DoD:** cannot merge without green CI. **Do NOT:** add `continue-on-error` to any quality gate.

#### TASK 0.3.1 — Destructive-primitive lint rule
**Milestone:** M0.3 · **Requirements:** C-03, §6.7 · **Risks:** R-06 · **Depends on:** 0.2.1 · **Size:** M · **Cost:** £0.00
**Context.** Code-layer half of the two-layer guard. Must exist before anything writes data.
**Steps.** 1. Custom ESLint rule banning `DeleteItemCommand`, `DeleteObjectCommand`, `DeleteObjectsCommand`, `BatchWriteItem` with `DeleteRequest`, raw `DELETE`/`TRUNCATE`/`DROP` SQL, and `s3:DeleteObject*` strings in IaC — across `services/`, `apps/`, `packages/`, `infra/` **and** `tests/`. 2. Allowlist only `infra/` constructs that *deny* the action. 3. Wire into CI as a blocking check.
**Tests.** **The guard's own test is the deliverable:** a fixture file containing `DeleteObjectCommand` must fail lint; CI proves the failure. Negative: allowlisted deny-policy file passes.
**Verification:** `pnpm lint:no-destructive` exits non-zero on the fixture.
**DoD:** a PR introducing a destructive primitive cannot merge. **Do NOT:** allow per-file disable comments for this rule.

#### TASK 0.3.2 — IAM deny guardrails
**Milestone:** M0.3 · **Requirements:** §6.7, NFR-03 · **Depends on:** 0.1.1, 0.3.1 · **Size:** M · **Cost:** £0.00
**Steps.** 1. Runtime role policy with explicit `Deny` on `s3:DeleteObject`, `s3:DeleteObjectVersion`, `dynamodb:DeleteItem`, `dynamodb:DeleteTable` against protected resources. 2. S3 bucket policy denying the same to the runtime principal. 3. Separate, unused **break-glass role** requiring MFA, documented in a runbook and *not* implemented in application code (§6.8).
**Tests.** Integration against emulated/ephemeral AWS: runtime role `DeleteObject` → `AccessDenied`; `PutObject` to a media prefix → succeeds; policy simulator assertions in CI.
**DoD:** deletion denied at code **and** IAM layers, both proven by tests. **Do NOT:** implement any break-glass deletion code path.

#### TASK 0.3.3 — Soft-delete + audit primitives
**Milestone:** M0.3 · **Requirements:** §6.2–6.4, FR-X-03 · **Depends on:** 0.3.1 · **Size:** M · **Cost:** £0.00
**Steps.** Repository base class enforcing `created_at`, `updated_at`, `status` on every write; append-only audit writer; versioned-record helper (new version, never overwrite).
**Tests.** Unit: "delete" sets a status flag and the record remains readable by ID; audit entry written for every mutation; version N+1 never mutates version N. Negative: attempting an in-place overwrite of a clinical record throws.
**DoD:** no repository method exists that removes a row. **Do NOT:** add one "for tests".

#### TASK 0.3.4 — Schema separation for future lawful erasure
**Milestone:** M0.3 · **Requirements:** §6 note, NFR-04 · **Risks:** R-04 · **Depends on:** 0.3.3 · **Size:** S · **Cost:** £0.00
**Steps.** Split every person record into `clinical{}` (retention basis) and `personal{}` (name, contact, marketing prefs) attributes so a future human-authorised erasure of specific non-clinical fields needs no migration. Document in the DPIA skeleton.
**Tests.** Unit: projection helpers prove the two sets are independently addressable.
**DoD:** DPIA skeleton records the split. **Do NOT:** implement erasure.

#### TASK 0.4.1 — IaC baseline: DNS, certificate, CDN, storage, health check
**Milestone:** M0.4 · **Requirements:** C-07, C-08, NFR-01 · **Depends on:** 0.2.1, 0.3.2 · **Size:** M · **Cost:** +£0.42/mo
**Steps.** 1. CDK app: S3 site bucket (versioned, private, OAC), CloudFront PriceClass_100, ACM cert in us-east-1, HTTP API + `GET /health` Lambda (arm64). 2. Route 53 records for a **staging hostname only** (`next.nourishthenerve.com`) — the apex stays on the legacy site until G1. 3. Security headers + CSP via CloudFront response-headers policy. 4. First production deploy: an "it's alive" page.
**Tests.** Integration: `/health` returns 200 with a version string; CloudFront serves the page over TLS; security headers present. Negative: direct S3 URL is denied (OAC enforced).
**Verification:** `curl -sI https://next.nourishthenerve.com` → 200 + HSTS/CSP.
**Flag:** none. **DoD:** production deploy succeeded from CI via OIDC; apex site untouched. **Rollback:** `cdk destroy` of the new stack leaves the legacy site unaffected. **Do NOT:** change the apex or `www` DNS records in this task.

#### TASK 0.5.1 — Budgets and cost alarms
**Milestone:** M0.5 · **Requirements:** C-01, NFR-02 · **Depends on:** 0.4.1 · **Size:** S · **Cost:** £0.00 (≤2 budgets free)
**Steps.** Budget at £20 with alerts at 50/75/90%; anomaly detection; alarm → email. Cost allocation tags on every resource.
**Tests.** Integration: simulate a threshold breach via a forced budget notification and assert the alert fires (evidence in PR — the brief requires alarms *proven* at G0).
**DoD:** alarms demonstrably fire in a test. **Do NOT:** rely on Cost Explorer API polling (it bills per request).

#### TASK 0.5.2 — Log retention and volume control
**Milestone:** M0.5 · **Requirements:** FR-X-05 · **Risks:** R-11 · **Depends on:** 0.4.1 · **Size:** S · **Cost:** ~£1.00/mo
**Steps.** 14-day retention on every log group by CDK default; sampled request logging; alarm on ingestion GB/day.
**Tests.** Integration: new log groups are created with 14-day retention (assert in CDK snapshot test).
**DoD:** no log group has infinite retention.

#### TASK 0.5.3 — SMS hard-cap mechanism
**Milestone:** M0.5 · **Requirements:** C-02, C-11, NFR-09 · **Risks:** R-01, R-02 · **Depends on:** 0.5.1 · **Size:** M · **Cost:** £0.00 (no SMS sent yet)
**Context.** Built **before** any SMS can be sent, so the cap can never be breached even once.
**Steps.** 1. Atomic monthly counter in DynamoDB (conditional update) holding spend in pence. 2. `canSend()` returns false at the £5 cap — **a block, not an alert**. 3. `+44`-only destination allow-list with E.164 normalisation. 4. Per-principal rate limit. 5. Provider-side monthly spend limit set as an independent backstop. 6. Kill switch parameter in SSM.
**Interfaces:** `sendSms(to: E164, template, vars): Result<Sent, Blocked|Capped|NotUk|RateLimited>`.
**Tests.** Unit: cap boundary at £4.99/£5.00/£5.01; non-UK numbers rejected (+1, +33, +44 spoofs like `+4401`); E.164 normalisation. Integration (emulated): 200 concurrent sends stop at the cap with no overshoot; counter is atomic under contention. **Cost-abuse:** allow-list rejects non-UK; rate limit returns the correct error; kill switch blocks everything.
**Flag:** `sms.enabled` — default **off**, you flip it. **DoD:** tests prove the cap blocks. **Do NOT:** send a real SMS in any test.

#### TASK 0.6.1 — Feature flags
**Milestone:** M0.6 · **Requirements:** §10 · **Decisions:** D-23 · **Depends on:** 0.4.1 · **Size:** S · **Cost:** £0.00
**Steps.** SSM-backed flag store, cached in-process with short TTL; typed accessor; default-off for every new flag.
**Tests.** Unit: unknown flag returns false; cache honours TTL. **DoD:** incomplete work can merge dark.

#### TASK 0.6.2 — Canary deploy, smoke test, auto-rollback
**Milestone:** M0.6 · **Requirements:** C-06, C-07, NFR-01 · **Risks:** R-08 · **Depends on:** 0.6.1 · **Size:** M · **Cost:** £0.00
**Steps.** 1. Lambda alias with weighted routing (10% → 100% over 5 min). 2. CloudWatch alarm on 5xx/latency wired to the deployment. 3. Post-deploy smoke test hitting `/health` and a real page. 4. Failure → automatic alias rollback. 5. `docs/runbooks/rollback.md`.
**Tests.** Integration: deliberately deploy a failing build to an ephemeral environment; assert automatic rollback and that the previous version still serves.
**DoD:** rollback demonstrated, not described. **Do NOT:** allow a deploy path that bypasses the alias.

#### TASK 0.6.3 — Ephemeral per-PR environments
**Milestone:** M0.6 · **Requirements:** §10 · **Depends on:** 0.6.2 · **Size:** M · **Cost:** £0.00 standing
**Steps.** CI job deploys a uniquely-named stack per PR, runs integration + contract + a11y tests, then **destroys it in the same run** (including on failure, via `always()`).
**Tests.** Meta: a PR leaves no residual stack — CI asserts stack count returns to baseline.
**DoD:** zero standing cost proven by a stack-count assertion. **Do NOT:** leave orphaned stacks on failure.

**Gate G0:** production deploys and rolls back safely · guards demonstrably block a destructive change · budget alarms fire in a test · no long-lived credentials exist.

### Phase 1 — Public website

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

### Phases 2–7 — milestone plans + task stubs
*(Elaborated to full §12 detail at each gate, per D-27.)*

| Phase | Milestones | Stub tasks | Notes |
|---|---|---|---|
| **2 — Identity & roles** | M2.1 auth · M2.2 notifications · M2.3 RBAC + audit · M2.4 clinician accounts · M2.5 assignment/reassignment | 2.1.1–2.5.3 (~14) | **Proposed reordering:** pull M2.3 (RBAC spine + audit) earlier — see §9 |
| **3 — Clinical core** | M3.1 patient record · M3.2 diagnosis/care plan/private notes · M3.3 assessment forms · M3.4 appointments + reminders · M3.5 content + media · M3.6 messaging | ~18 | R-09 boundary work concentrated in M3.2 |
| **4 — Video** | M4.1 signalling · M4.2 server-side call authz · M4.3 peer connection + device check + fallback · M4.4 TURN + caps · M4.5 join-button state machine | ~12 | R-03 mitigations in M4.4 |
| **5 — Hardening & launch** | M5.1 load test 10× · M5.2 security review · M5.3 a11y audit · M5.4 **restore drill executed** · M5.5 runbooks + cost reconciliation | ~10 | G5 = WEB IS DONE |
| **6 — Mobile** | M6.1–M6.7 | ~14 | Only after G5; additive versioned API changes only |
| **7 — Post-launch** | Analytics within privacy constraints, cost review, deferred backlog **incl. chatbot (D-05) if solicitor clears scope** | — | |

---

## 8. Gate checklists

At every gate I run and report: full test suite (with skips explained) · requirement traceability (complete/partial/untouched) · regression diff against the previous gate · **authorisation-boundary re-audit from scratch** · destructive-code audit of the diff · **actual spend vs model across the whole C-01 envelope** · security + dependency check · a11y and i18n check on new surfaces · production health (uptime, error rate, rollbacks) · go/no-go · **elaboration of the next phase's stubs** · re-verification of `UNVERIFIED` and >90-day-old prices.

Gate-specific additions: **G0** guards block a real destructive PR; alarms fire in test · **G1** apex serving new site, legacy retired, Core Web Vitals pass · **G2** negative test for every cross-tenant path · **G3** no private field reachable by a patient in any code path · **G4** real cross-network call; measured relay cost vs model · **G5** restore drill evidence; load test at 10×.

---

## 9. Traceability (summary)

Every FR/NFR maps to ≥1 task and ≥1 test. Full matrix in `docs/plan/07-traceability.md`. Coverage as planned: **FR-PP** 12/12 · **FR-DP** 12/12 · **FR-WEB** 6/7 (FR-WEB-03 deferred by D-05, tracked not dropped) · **FR-VID** 6/6 · **FR-X** 7/7 · **NFR** 9/9.

---

## 10. Long-lead register

| ID | Item | Owner | Lead time | Blocks | Start |
|---|---|---|---|---|---|
| LL-01 | **SES production access in the new account** | Me (raise) / you (approve) | days–2 wks | All email → G1 | **Phase 0** |
| LL-02 | UK SMS provider onboarding + sender-ID registration | You | 2–4+ wks | M2.2 | Phase 0 |
| LL-03 | Stripe account verification / KYC | You | days–2 wks | M1.5 | Phase 1 |
| LL-04 | ICO registration | **You** | ~1 wk | Launch | Phase 0 |
| LL-05 | DPIA completion with a DPO | You | wks | Launch | Phase 1 |
| LL-06 | **Solicitor/DPO on the erasure tension (R-04)** | You | wks | Launch | **Phase 0** |
| LL-07 | Solicitor on chatbot medical-device scope (R-05) | You | wks | Phase 7 only | Deferred |
| LL-08 | Translation of launch content | You | wks | Only when languages named | On D-04 trigger |
| LL-09 | Apple Developer enrolment (D-U-N-S) | You | 2–4 wks | Phase 6 | After G5 |
| LL-10 | Google Play data-safety declarations | You | ~1 wk | Phase 6 | After G5 |

---

## 11. Plan self-audit

- **Coverage:** every FR/NFR maps to ≥1 task and ≥1 test; every risk R-01…R-14 has a named mitigating task. FR-WEB-03 is the sole uncovered requirement, deliberately, by D-05.
- **Ordering:** the dependency graph is acyclic — checked by walking every task's `Depends on` and confirming each names only lower-numbered tasks. Guards (0.3.x) precede all data writes; the SMS cap (0.5.3) precedes any send; canary/rollback (0.6.2) precedes user-facing features. After every task the tree builds and production works; incomplete work merges dark behind flags.
- **Cost roll-up:** £8.00/month at M12 against a £12–14 target and £20 cap — **£4–6 headroom to target, £12 to cap.** No line depends on an expiring free tier.
- **`UNVERIFIED` prices:** .com renewal · AWS UK SMS unit price · Cloudflare TURN free-tier period · Vonage UK SMS · MEF lead time · Apple GBP fee · EBS gp3 + IPv4. Each re-verified at G0 and every 90 days (§14.12).

**Red-team — the five likeliest ways this plan fails:**

1. **SMS arithmetic bites at scale.** 500 patients × weekly reminders ≫ 108 messages. *Changed:* email-primary from day one, SMS behind a proven hard block, degradation defined before launch, push prioritised in Phase 6.
2. **The private-field boundary leaks through a path nobody tested** — an export, a log line, an error message, a cache. *Changed:* enforcement moved to a single repository-layer projection rather than per-handler, 100% coverage on that chokepoint, and a re-audit *from scratch* at every gate rather than only when the code changes.
3. **DynamoDB single-table design meets a §7 query it can't serve** (admin cross-caseload views, keyword matching) and forces a costly migration mid-build. *Changed:* ADR-002 must prove every §7 query against the key schema **before** any table code is written, and names the fallback explicitly.
4. **Zero staging plus a bad merge takes production down** in front of patients. *Changed:* five independent layers — contract tests, ephemeral PR environments, dark merges behind flags, canary with automatic rollback, and post-deploy smoke — with rollback *demonstrated* at G0, not documented.
5. **Cost creeps invisibly** — log volume, an unmetered path, a retained-media surprise — and the cap is breached before anyone notices. *Changed:* budgets and alarms land in Phase 0 *before* anything can spend, 14-day log retention is a CDK default rather than a habit, and every gate reconciles actual spend against this model across the whole envelope, not just AWS.

**Where I'd push back on the brief (§16.8):** §11 places the entire public website (Phase 1) before any identity or authorisation work (Phase 2). That defers the authorisation boundary — the component where a mistake is most catastrophic and most expensive to retrofit — until after five milestones of accumulated momentum, while front-loading the surface with the least clinical risk. I have **not** silently reordered. I recommend pulling M2.3 (RBAC enforcement layer + audit log) forward to sit alongside M1.1, so the spine exists and is exercised for the whole of Phase 1 before real patients exist. Your call at G1.

---

## Appendix A — Stage A findings (verified 2026-08-07)

**Repo:** zero commits, empty private remote, no CI/IaC/code. `gh` not installed locally.
**DNS/email:** apex + `www` → CloudFront `d2z3fclxq13w3z.cloudfront.net`, **a distribution in a different, unidentified AWS account**; we hold the Route 53 zone, so cutover is ours. Live brochure last modified 24 Feb 2026, loads Google Fonts over plain `http://`. MX → Zoho Mail EU with SPF + DKIM; **no DMARC**.
**AWS 803129122420:** shared personal account (also runs islamicmaps.org — 9 stacks, WAF, Amplify) accessed by **root access keys**; oldest role Nov 2017 ⇒ legacy free-tier account. NDN pieces: S3 `nourishthenerve` (`clients/` 16 objects/361 MB, `posts/` 1 object; **versioning off**) and Lambda `nourishthenerve-api` (python3.11, **Function URL AuthType NONE, CORS ***, role granting `s3:DeleteObject` on the whole bucket, click-ops, no IaC). **SES sandboxed** in eu-west-2 and us-east-1; **SNS SMS spend limit $1**. July bill $8.84 total (~$1–2 attributable to NDN); no NDN budget or alarms.
**Verified unit prices** (Price List API + provider pages, 2026-08-07): Lambda $0.20/1M req, arm64 $0.0000133334/GB-s · HTTP API $1.16/1M · DynamoDB $0.1487/1M RRU, $0.7423/1M WRU, PITR $0.23772/GB-mo · S3 $0.024/GB-mo · CloudFront $0.060/GB EU, 1,000 free invalidations/mo · CloudWatch logs **$0.5985/GB**, alarms $0.10 · SES $0.10/1k · **Cognito Lite/Essentials/Plus $0.0055/$0.015/$0.020 per MAU, 10,000 free MAU on Lite and Essentials, email-OTP requires Essentials** · KMS $1/key · Secrets Manager $0.40/secret · t4g.nano $0.0047/hr · Twilio UK SMS $0.056 · **Cloudflare TURN 1,000 GB free** then $0.05/GB · Stripe UK 1.5%+20p · UptimeRobot/Turnstile/GitHub free tiers · Bedrock London: Sonnet/Opus-class in-region, EU profile adds Opus 5/Fable 5, **no Haiku-class**.
**Free-tier regime:** post-15-Jul-2025 accounts get Free Plan ($200 credits, 6 months, then closure) or Paid Plan; **org member accounts forfeit credits** but keep the 30+ **always-free** offers per account — which is why D-01 is cheaper, not merely tidier.
