# Gate G0 report — Phase 0 complete

**Date:** 2026-08-13 · **Scope:** TASK 0.0.1 through 0.6.3 (all merged) · **Checklist:** [06-gate-checklists.md](06-gate-checklists.md)

## Go/no-go

**GO**, with two items the account owner should act on promptly (SES production access, `ndn-admin` credential posture — both below) and a short list of disclosed, low-severity gaps carried forward rather than silently closed. Nothing found blocks starting Phase 1. No patient, clinical, content, or media data exists yet, so the destructive-primitive guarantees have not yet been tested against real stakes — they have, however, been proven against fixtures and live AWS policy simulation.

## 1. Full test suite

`pnpm -r lint && pnpm -r typecheck && pnpm -r test` run fresh against `main` (2026-08-13):

- **Lint:** clean across all 12 workspace packages.
- **Typecheck:** clean across all 12 workspace packages.
- **Tests:** 145 tests / 32 files, 0 failures (`apps/web` 1, `apps/mobile` 1, `packages/api-client` 1, `packages/shared-types` 1, `packages/i18n` 1, `packages/eslint-plugin-no-destructive` 12, `packages/ui` 1, `services/workers` 1, `services/api` 76, `tests` 1, `infra` 50).
- **CI on `main`:** the run that includes 0.6.3 (`31688467282`) is green end-to-end, including a real `cdk deploy` to production. No skips to explain.

## 1a. Regression diff against the previous gate

Not applicable — G0 is the first gate. There is no prior gate baseline to diff against; §1's full test suite and §8's production health serve as the baseline this gate itself establishes for G1 to diff against.

## 2. Requirement traceability

Full per-task table below (Milestone/Requirements tags per [05-execution-plan.md](05-execution-plan.md), evidence per `docs/runbooks/*.md`, cross-checked live where the claim was AWS-verifiable).

| Task | DoD | Status | Note |
|---|---|---|---|
| 0.0.1 Commit the plan | Manifest present; PR opened | **COMPLETE*** | First commit landed directly (no repo existed to PR against yet) — inherent to bootstrapping, not a process failure. |
| 0.0.2 Contain legacy delete path | Versioning on; delete/put denied | **COMPLETE** | Re-verified live today against `803129122420`: `GetBucketVersioning` → `Enabled`; policy simulator → `PutObject`/`DeleteObject` both `implicitDeny`. |
| 0.1.1 AWS account + identity baseline | No IAM users with access keys in the new account | **GAP (disclosed, owner-approved)** | `ndn-admin` exists with `AdministratorAccess` and an active long-lived key — see §3. |
| 0.1.2 Monorepo scaffolding | Clean run on a fresh clone | **COMPLETE** | |
| 0.2.1 CI pipeline | Cannot merge without green CI | **GAP (platform-limited)** | GitHub Free has no branch protection on a private repo (confirmed live: `403 Upgrade to GitHub Pro`). Enforcement today is human discipline only — the account owner is the sole merger. |
| 0.3.1 Destructive-primitive lint rule | A destructive-primitive PR cannot merge | **COMPLETE** | Re-ran `pnpm lint:no-destructive` fresh: 11/11 fixture violations caught, non-zero exit. Fresh repo-wide grep for live (non-fixture, non-test) destructive primitives: zero hits. |
| 0.3.2 IAM deny guardrails | Denied at code + IAM layers | **COMPLETE** | `guardrails.ts` deny statements are tested (50 infra tests) but not yet attached to a live runtime role — correctly so, since no data-writing role exists until Phase 3. `ndn-break-glass` confirmed live: trust requires MFA, zero permissions attached. |
| 0.3.3 Soft-delete + audit primitives | No repository method removes a row | **COMPLETE** | |
| 0.3.4 Schema separation | DPIA skeleton records the split | **COMPLETE** | |
| 0.4.1 IaC baseline | Prod deploy via CI/OIDC; apex untouched | **COMPLETE** | Closes a gap the runbook itself left open — today's live CI run is the actual proof: OIDC-authenticated `cdk deploy` succeeded from GitHub Actions. `next.nourishthenerve.com` → 200, HSTS/CSP/X-Frame-Options present, `/health` version matches `main`'s HEAD. Legacy apex still redirects to the untouched legacy site. |
| 0.5.1 Budgets and cost alarms | Alarms fire in a test | **COMPLETE** | Live budget `ndn-monthly-cost-cap` confirmed at $24.21 (£20) limit, actual spend $0.025, all three thresholds `OK`. |
| 0.5.2 Log retention and volume control | No log group has infinite retention | **PARTIAL** | See §4 — 4 of 6 live log groups have no retention set. |
| 0.5.3 SMS hard-cap mechanism | Tests prove the cap blocks | **COMPLETE** | No SMS provider wired yet — cap cannot have been breached even in principle. |
| 0.6.1 Feature flags | Incomplete work merges dark | **COMPLETE** | |
| 0.6.2 Canary/rollback | Rollback demonstrated | **COMPLETE** | Also caught and fixed the 0.5.2 regression below as a prerequisite. |
| 0.6.3 Ephemeral PR environments | Zero standing cost, stack-count-asserted | **COMPLETE**, with a caveat | Stack-level cleanup confirmed live (only `NdnWebStack`/`NdnBudgetStack`/`CDKToolkit` exist — no `Pr23`/`Pr999` stacks remain). The CI job (`pr-environment`) that runs this proof is explicitly labelled `informational — not yet gating` in the required-checks gate — a future PR that breaks cleanup would still merge. Log-group-level cleanup is incomplete — see §4. |

\* Not a finding requiring action — noted for completeness only.

**Coverage summary (unchanged from plan-time):** every Phase 0 requirement tag (C-01, C-02, C-03, C-06, C-07, C-08, C-09, C-11, NFR-01, NFR-02, NFR-03, NFR-06, NFR-08, NFR-09, §6.7) maps to ≥1 completed task; FR-* coverage is Phase-1-onward and untouched, as planned.

## 3. Authorisation-boundary re-audit (from scratch, live against both AWS accounts)

- **`803129122420`** (legacy/shared with unrelated `islamicmaps`): root access keys still exist and are in active CLI use (confirmed — this session used them for read-only checks). This is **known and already tracked** as D-28/R-07, explicitly deferred to the account owner with no deadline. Not re-flagged as new.
- **`357601815388` (`ndn-prod`):** no root key use observed. `ndn-deploy` (OIDC, `main`-branch-only, scoped by GitHub's immutable org/repo IDs not by name) → `PowerUserAccess`, verified via `iam simulate-principal-policy` today: `cloudformation:DescribeStacks` allowed, `iam:CreateUser` denied. `ndn-deploy-pr` and `ndn-ci-readonly` (OIDC, PR-scoped) hold only narrow inline policies (assume two named CDK bootstrap roles; simulate two named things). `ndn-break-glass` requires MFA and holds zero permissions. All four match their runbooks exactly.
- **New finding — `ndn-admin`:** an IAM user in `ndn-prod` with `AdministratorAccess` attached directly, an **active long-lived access key** (created 2026-08-08, still Active), and **no MFA device registered**. This is disclosed in `aws-account-baseline.md` as a deliberate, informed substitution for IAM Identity Center — AWS root cannot `AssumeRole` into a fresh Organizations member account, which blocked the plan's original SSO approach. The substitution is reasonable engineering; the residual gap is that this key is exactly the kind of credential R-07 exists to eliminate, and it currently has no second factor. **Recommend:** add an MFA device to `ndn-admin` (console-only action, owner has the credentials) — everything else about the setup is sound.
- **Legacy Lambda role** (`nourishthenerve-api-role-56voptv0` in `803129122420`): re-confirmed live today, `GetObject` allowed, `PutObject`/`DeleteObject` `implicitDeny`. Two **pre-existing, already-flagged** issues carried forward unchanged from `legacy-estate.md`, neither newly discovered: the public Function URL's `/client/{id}/report` route has no auth (unauthenticated enumeration of client media/reports — R-09-adjacent), and `/form` 404s (contact form silently broken on the live legacy site). Both are explicitly out of TASK 0.0.2's scope and are due to be resolved by the G1 cutover (TASK 1.6.1) — flagged again here so they aren't lost.

## 4. Destructive-code audit

- Repo-wide grep for `DeleteItemCommand`, `DeleteObjectCommand(s)`, `BatchWriteItem`+`DeleteRequest`, raw `DROP`/`TRUNCATE`/`DELETE FROM`, `s3:DeleteObject*` strings: **zero hits** outside the lint rule's own fixture/test files.
- `pnpm lint:no-destructive` re-run fresh: 11/11 known-bad patterns caught, exits non-zero.
- **New, minor finding:** two orphaned CloudWatch log groups from destroyed ephemeral PR stacks (`.../NdnWebStackPr23-CustomCDKBucketDeployment...`, `.../NdnWebStackPr999-CustomCDKBucketDeployment...`) — both **0 bytes stored**, so £0 cost impact, but both have **no retention policy** (CDK does not attach a `DeletionPolicy` to a Lambda's implicitly-created log group by default, so it survives its parent stack's deletion). The same gap exists on the *live* stack's own implicit log groups (`NdnWebStack-HealthFunction...`, `NdnWebStack-CustomCDKBucketDeployment...` both show `Retention: None`) — only the two explicitly-constructed groups (`/ndn/health-function`, `/ndn/smoke-test-function`) actually got the 14-day policy from TASK 0.5.2. This is a real, if currently free, breach of that task's DoD ("no log group has infinite retention") and is worth a small follow-up fix (apply the retention aspect to Lambda's default log group too, or pass `logGroup` explicitly everywhere; add `removalPolicy: DESTROY` so ephemeral stacks clean up completely). Not fixed in this PR — it's an infra-code change, out of scope for a docs-only gate review; recommend a short follow-up task before Phase 1's log volume grows.

## 5. Actual spend vs model (whole C-01 envelope)

- **`ndn-prod` (Cost Explorer, 2026-08-01→13):** $0.025 actual against the AWS Budgets alarm's $24.21 (£20) limit. Dominated by S3 ($0.013) and the Cost Explorer API call itself ($0.01 — a reminder of why 0.5.1 correctly avoids CE polling for the alarm mechanism).
- **`803129122420` (Route 53, filtered to that service only):** $1.00 across two hosted zones this month (`nourishthenerve.com` + unrelated `islamicmaps.org`) — nourishthenerve's share (~$0.50) matches the cost model's Route 53 line almost exactly.
- **Model correction:** `.com` renewal was `UNVERIFIED` at ~$14/yr; live AWS pricing (`aws route53domains list-prices --tld com`, 2026-08-13) is **$16.00/yr**. Cost model updated (§9 below) — M1 total moves from £2.57 to **£2.70**, still £4–6 under the £12–14 target and £12+ under the £20 cap. Immaterial to the go/no-go.
- **Scope note:** DNS/domain costs bill against `803129122420` under the same consolidated payer as `ndn-prod`, not against `ndn-prod`'s own $24.21 budget — so the 0.5.1 alarm would not catch a Route 53 cost spike. At ~£0.40/month this is not worth a second budget today, but note it if that line ever moves.

## 6. Security + dependency check

- `pnpm audit --prod`: no known vulnerabilities.
- GitHub Dependabot alerts: enabled (verified via `vulnerability-alerts` endpoint), zero open alerts.
- GitHub secret scanning: **disabled** — a GitHub Free private-repo limitation, not a configuration miss (confirmed via API: `"Secret scanning is disabled on this repository"`). Compensating control already in place: CI's own `gitleaks` job runs on every push (proven in the 0.2.1 runbook). Residual gap: gitleaks only sees the diff of a push, not GitHub's continuous historical re-scan — low risk at this repo's size and age but worth knowing.

## 7. a11y / i18n on new surfaces

Phase 0 shipped exactly one user-visible surface: the `next.nourishthenerve.com` "it's alive" placeholder. `lang="en"` set, viewport meta present, single semantic `<main>`, no interactive elements, no images, default high-contrast text — nothing to fail. i18n framework is correctly not-yet-built (that's TASK 1.1.2); no hard-coded-string concern yet since there's exactly one string, on a placeholder page explicitly labelled as such.

## 8. Production health

- `next.nourishthenerve.com`: `200`, TLS via CloudFront, HSTS + CSP + X-Frame-Options + X-Content-Type-Options + Referrer-Policy all present. `/health` reports `{"status":"ok","version":"eab3e1b..."}` — matches `main`'s current HEAD, confirming the live deploy is current.
- Legacy `nourishthenerve.com` apex: still 302 → `www`, untouched, as D-25 requires until G1.
- CloudWatch alarms: `HealthAliasErrorsAlarm`, `HealthAliasLatencyAlarm`, `ndn-log-ingestion-volume` — all `OK`.
- **Incident, now resolved:** production deploys were **broken for ~2 days** (2026-08-10 20:37 → 2026-08-13 08:50) by a CloudWatch alarm using a `MathExpression`/`SEARCH()` construct AWS's Metric Alarm API rejects. Every push to `main` in that window (`0.5.3`, `0.6.1`) failed at the `cdk deploy` step and auto-rolled back `NdnBudgetStack`; `NdnWebStack` was never touched by either failed run (`cdk deploy --all` never got past the failing stack), so the live site was never affected — only new budget-stack changes were blocked. Fixed in PR #21, confirmed by today's green run. No corrective action needed beyond what already happened; noted here so the ~2-day gap isn't lost from the record.

## 9. Files changed by this gate pass

- `docs/plan/03-cost-model.md` — `.com` renewal re-priced from an UNVERIFIED ~$14/yr estimate to a verified $16.00/yr; totals recalculated.
- `docs/plan/09-self-audit.md` — records the G0 price re-verification pass and why the other six UNVERIFIED prices are correctly deferred.
- `docs/plan/05-execution-plan.md` — Phase 1 (1.1.1–1.6.1) elaborated from one-line stubs to full task detail per D-27, ahead of Phase 1 execution starting.
- `docs/plan/gate-g0-report.md` — this report.

## Action items for the account owner

1. **SES is still in sandbox** (`ProductionAccessEnabled: false`, confirmed live). This is LL-01, explicitly scheduled to start in Phase 0 given its days-to-2-week lead time, and it blocks all outbound email through G1 — including TASK 1.4.1 (contact form) and 1.5.2 (workshop confirmation emails) in the phase about to start. It was not yet raised. Recommend raising it immediately; happy to submit the request now if you confirm.
2. **Add an MFA device to `ndn-admin`** — the one AWS-side change from this review that's worth doing regardless of anything else (console-only, a few minutes, closes the single largest credential-risk gap left standing).
3. Optional, zero cost, low priority: fix the Lambda-default-log-group retention/cleanup gap (§4) in a small follow-up before Phase 1's traffic grows the log volume; consider promoting `pr-environment` from informational to a required CI check now that it's proven stable (§2, 0.6.3).
