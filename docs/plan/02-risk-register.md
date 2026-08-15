# 2. Risk register

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
| **R-15** | G1 cutover blocked: CloudFront's global alias-uniqueness constraint prevents adding apex/`www` to `NdnWebStack` while the legacy distribution — in an unidentified third AWS account — still holds those aliases; confirmed by a live attempt (2026-08-15, ~72s error-page window, reverted) | High | High | **Unresolved** — needs either cooperation from whoever controls the account serving `d2z3fclxq13w3z.cloudfront.net`, or an AWS Support case to move the alternate domain names cross-account. Not a retry-able engineering fix | 1.6.1, `docs/runbooks/g1-cutover.md` |
