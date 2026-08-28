# Runbook index (TASK 5.5.2)

This directory holds one runbook per task, or per closely-related task cluster — the pattern this plan has followed since Phase 0 (`video-calls.md` alone covers five). Nothing indexed them until this task; every file below stays exactly where it is (**never deleted, never merged** — this is a consolidation pass, one layer added above 51 files, not a rewrite of any of them). Group headings roughly follow the execution plan's own phases/subsystems; a runbook that spans several tasks is listed once, under whichever heading its primary subject matches.

## Foundations, IaC, and CI/deploy

- [monorepo-scaffolding.md](monorepo-scaffolding.md) — pnpm workspaces, strict TS, lint/format/test harness (TASK 0.1.2)
- [aws-account-baseline.md](aws-account-baseline.md) — the `ndn-prod` account, IAM Identity Center, OIDC deploy role (TASK 0.1.1)
- [legacy-estate.md](legacy-estate.md) — findings and containment of the pre-existing public Lambda/S3 estate (TASK 0.0.2)
- [ci-pipeline.md](ci-pipeline.md) — the CI workflow: lint, typecheck, test, coverage, audit, secret scan (TASK 0.2.1)
- [destructive-primitive-lint-rule.md](destructive-primitive-lint-rule.md) — the ESLint rule banning `DeleteItem`/`DeleteObject`/etc. (TASK 0.3.1)
- [iam-deny-guardrails.md](iam-deny-guardrails.md) — explicit IAM `Deny` on delete actions, the runtime-layer half of the guard (TASK 0.3.2)
- [soft-delete-audit-primitives.md](soft-delete-audit-primitives.md) — the repository base class: soft-delete, append-only audit, versioned records (TASK 0.3.3)
- [schema-separation-lawful-erasure.md](schema-separation-lawful-erasure.md) — `clinical{}`/`personal{}` field split for a future lawful erasure (TASK 0.3.4)
- [iac-baseline.md](iac-baseline.md) — DNS, ACM certificate, CloudFront, S3, the health-check Lambda (TASK 0.4.1)
- [budgets-cost-alarms.md](budgets-cost-alarms.md) — the `£20` budget, alert thresholds, anomaly detection (TASK 0.5.1)
- [log-retention-volume-control.md](log-retention-volume-control.md) — 14-day log retention, sampled logging, the log-volume alarm, and the TASK 5.1.2-era finding that every hand-rolled Lambda role had never been granted permission to write its own logs (TASK 0.5.2)
- [sms-hard-cap.md](sms-hard-cap.md) — the atomic monthly SMS spend cap, built before any SMS could be sent (TASK 0.5.3)
- [feature-flags.md](feature-flags.md) — the SSM-backed, cached, default-off flag store (TASK 0.6.1)
- [rollback.md](rollback.md) — canary alias deploy, smoke test, automatic rollback (TASK 0.6.2)
- [ephemeral-pr-environments.md](ephemeral-pr-environments.md) — a disposable `WebStack` copy per open PR, destroyed in the same CI run (TASK 0.6.3)
- [core-web-vitals.md](core-web-vitals.md) — Lighthouse/Core Web Vitals measurement against the live site
- [prod-deploy-gsi-catchup.md](prod-deploy-gsi-catchup.md) — the incident where three GSIs shipped in code but were never actually created in production, and its three-step catch-up

## Public site, content, and commerce

- [contact-form.md](contact-form.md) — SES relay, Turnstile, rate limiting (TASK 1.4.1)
- [content-authoring.md](content-authoring.md) — blog authoring, publish/unpublish, SEO (TASK 1.3.2)
- [testimonials.md](testimonials.md) — moderation queue and consent record for published testimonials (TASK 1.4.2)
- [workshops.md](workshops.md) — the workshop model, poster images, per-language detail pages (TASK 1.5.1)
- [stripe-checkout-registration.md](stripe-checkout-registration.md) — Stripe Checkout, idempotent webhooks, registration confirmation email (TASK 1.5.2)
- [workshop-confirmation-sms.md](workshop-confirmation-sms.md) — SMS-first workshop confirmation, phone number collection
- [g1-cutover.md](g1-cutover.md) — the apex/`www` DNS cutover from the legacy site, legacy Lambda decommission (TASK 1.6.1)
- [g1-cutover-support-case.md](g1-cutover-support-case.md) — the AWS Support case that resolved the CloudFront alias-uniqueness blocker

## Auth and identity

- [cognito-user-pools.md](cognito-user-pools.md) — the two Cognito user pools, one per role, and why not one pool with groups (TASK 2.2.1)
- [lambda-authorizer.md](lambda-authorizer.md) — the shared Lambda authorizer verifying tokens from either pool (TASK 2.2.2)
- [patient-registration.md](patient-registration.md) — patient self-registration and the clinician approval lifecycle (TASK 2.2.3)
- [web-authentication.md](web-authentication.md) — the authenticated account shell: sign-in, the session, sign-out (TASK 2.2.4)
- [clinician-accounts.md](clinician-accounts.md) — clinician account provisioning, and the two live bugs found provisioning the first real principal (TASK 2.4.1)
- [admin-token-retirement.md](admin-token-retirement.md) — retiring the shared `ADMIN_API_TOKEN` bearer gate once the real authorizer covers everything it did (TASK 2.5.4)

## Data, clinical records, and the authorisation boundary

- [private-field-boundary.md](private-field-boundary.md) — the repository-layer `private{}` projection no serialiser can bypass (TASK 2.1.2)
- [audit-log.md](audit-log.md) — the persistent, append-only audit log every mutation and authorisation decision writes to (TASK 2.1.3)
- [patient-assignment.md](patient-assignment.md) — approving/declining a patient, and clinician reassignment with an append-only history (TASK 2.5.1 / 2.5.2)
- [caseload-view.md](caseload-view.md) — the principal clinician's cross-caseload view, and GSI3 (TASK 2.5.3)
- [patient-record.md](patient-record.md) — the patient's own profile, read and updated (TASK 3.1.1)
- [clinical-record.md](clinical-record.md) — diagnosis and care plan, versioned, clinician-authored, with private notes (TASK 3.2.1)
- [assessment-forms.md](assessment-forms.md) — assessment forms, the `visible{}`/`private{}` two-row split (TASK 3.3.1)
- [appointments.md](appointments.md) — appointment scheduling and the clinician calendar, GSI1's second half (TASK 3.4.1)
- [appointment-reminders.md](appointment-reminders.md) — the 1-hour reminder sweep, GSI4, and the first real SMS send (TASK 3.4.3)
- [content-assignment.md](content-assignment.md) — a clinician assigning existing content to a patient (TASK 3.5.1)
- [messaging.md](messaging.md) — rate-limited patient↔clinician messaging (TASK 3.6.1)

## Notifications

- [notifications.md](notifications.md) — the notification abstraction: email/SMS, defined degradation, never a silent drop (TASK 2.3.1)
- [sms-provider.md](sms-provider.md) — AWS End User Messaging as the real SMS provider, ADR-0008's rate correction (TASK 2.3.2)
- [email-events.md](email-events.md) — SES bounce/complaint handling, the SNS event pipeline, its own confirmed subscription
- [workshop-confirmation-sms.md](workshop-confirmation-sms.md) — see Public site section above (also a notifications task)

## Video calling

- [video-signalling.md](video-signalling.md) — the WebSocket signalling channel: connect, disconnect, call authorisation, the relay (TASK 4.1.1, TASK 4.2.1, TASK 4.2.2)
- [video-calls.md](video-calls.md) — the peer connection, device check, ICE-failure fallback, TURN credentials, the relay cap, the join button (TASK 4.3.1, TASK 4.3.2, TASK 4.3.3, TASK 4.4.1, TASK 4.4.2, TASK 4.5.1)

## Phase 5 — capacity, security, accessibility, recoverability, cost

- [load-testing.md](load-testing.md) — the 10×-derived load harness, the real HTTP baseline run, and the cold-start p95 finding (TASK 5.1.1, TASK 5.1.2)
- [live-session-accessibility.md](live-session-accessibility.md) — the real, signed-in, live-session axe + keyboard sweep for the account shell (TASK 5.3.1, TASK 5.3.2)
- [restore-drill.md](restore-drill.md) — a real DynamoDB PITR restore, executed and measured; the D-22 export layer named as missing, then built (TASK 5.4.1)
- [backup-export.md](backup-export.md) — D-22's periodic export layer: a daily, GOVERNANCE-mode Object-Locked DynamoDB backup, built as its own task once `restore-drill.md` found it missing

Phase 5's security review (TASK 5.2.1) and DPIA update (TASK 5.2.2) live outside this directory by their own nature — `docs/plan/gate-g4-security-review.md` and `docs/compliance/dpia-skeleton.md` respectively, not duplicated here.

## What's still open, across every runbook above

A spot-check pass (not exhaustive — 51 files) found and closed three stale items this task's own writing exposed as already resolved: the `ndn-email-events` SNS subscription (confirmed live, [email-events.md](email-events.md)/[ses-production-access.md](ses-production-access.md)), the lambda authorizer's deferred token-based verification (proven as a side effect of the TASK 5.3.x live-session suite, [lambda-authorizer.md](lambda-authorizer.md)), and [g1-cutover.md](g1-cutover.md)'s own step 8 cost reconciliation (satisfied by TASK 5.5.1's account-wide pass). Everything else this pass checked was already accurately marked, open or closed.

Genuinely still open, owner-side, as of this pass (2026-08-28) — not stale, not this task's to close:

- **LL-01 (SES production access)** — denied 2026-08-21, [ses-production-access.md](ses-production-access.md). Blocks the real end-to-end checks named in [patient-registration.md](patient-registration.md) and [web-authentication.md](web-authentication.md).
- **LL-02 (UK SMS long code)** — not leased; AWS End User Messaging account confirmed still `SANDBOX` tier, 0 phone numbers, live-checked this pass. Blocks [sms-provider.md](sms-provider.md)'s real-account proof and [workshop-confirmation-sms.md](workshop-confirmation-sms.md).
- **Cloudflare Realtime/Calls TURN key** — not provisioned; `/ndn/cloudflare-turn-api-token` confirmed absent from SSM, live-checked this pass. Named since Gate G4 as the one blocking action item for a real cross-network video call, [video-calls.md](video-calls.md).
- **Real Turnstile widget + secret** — `contact-form.md` still runs Cloudflare's public test key; the real SSM SecureString parameter confirmed absent, live-checked this pass.
- **D-22's export layer is built** ([backup-export.md](backup-export.md)) but its restore-side check isn't — once a real export has run, import it into a scratch table and verify against known rows, the same discipline `restore-drill.md`'s own PITR half already used.
- **The cold-start / feature-flag SSM latency finding** — priced, not fixed, [load-testing.md](load-testing.md)'s TASK 5.1.2 section. Owner decision named there.
- **`video.signalling.enabled` and every other go-live flag** — deliberately off; TASK 5.5.3's own job, not this index's.

## Do NOT

Delete or merge a runbook file to "clean up" — the append-only, never-remove-history discipline this codebase applies to data applies to documentation too, now for the first time. Extend a runbook in place (every existing file's own convention) or add a new one; never fold two into one.
