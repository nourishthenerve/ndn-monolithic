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
- [sms-hard-cap.md](sms-hard-cap.md) — the atomic monthly SMS spend cap, built before any SMS could be sent (TASK 0.5.3); **unreachable since D-32 (2026-08-30)** — the reminder sweep, deleted, was the only caller that could ever have exercised it; kept in place, unused, not deleted
- [feature-flags.md](feature-flags.md) — the SSM-backed, cached, default-off flag store (TASK 0.6.1)
- [rollback.md](rollback.md) — canary alias deploy, smoke test, automatic rollback (TASK 0.6.2)
- [ephemeral-pr-environments.md](ephemeral-pr-environments.md) — a disposable `WebStack` copy per open PR, destroyed in the same CI run (TASK 0.6.3)
- [core-web-vitals.md](core-web-vitals.md) — Lighthouse/Core Web Vitals measurement against the live site
- [prod-deploy-gsi-catchup.md](prod-deploy-gsi-catchup.md) — the incident where three GSIs shipped in code but were never actually created in production, and its three-step catch-up

## Public site, content, and commerce

- [contact-form.md](contact-form.md) — SES relay, Turnstile, rate limiting (TASK 1.4.1); **deleted, not merely disabled, D-32 (2026-08-30)** — the form, its route, and its Lambda are gone from the codebase; the contact page links to WhatsApp instead
- [content-authoring.md](content-authoring.md) — blog authoring, publish/unpublish, SEO (TASK 1.3.2)
- [testimonials.md](testimonials.md) — moderation queue and consent record for published testimonials (TASK 1.4.2)
- [workshops.md](workshops.md) — the workshop model, poster images, per-language detail pages (TASK 1.5.1)
- [stripe-checkout-registration.md](stripe-checkout-registration.md) — Stripe Checkout, idempotent webhooks, registration confirmation email (TASK 1.5.2); **abandoned before its first real use, D-31 (2026-08-29)** — built and tested, never wired into any page, `payments.stripeCheckout.enabled` never to be turned on
- [workshop-confirmation-sms.md](workshop-confirmation-sms.md) — SMS-first workshop confirmation, phone number collection
- [g1-cutover.md](g1-cutover.md) — the apex/`www` DNS cutover from the legacy site, legacy Lambda decommission (TASK 1.6.1)
- [g1-cutover-support-case.md](g1-cutover-support-case.md) — the AWS Support case that resolved the CloudFront alias-uniqueness blocker

## Auth and identity

- [cognito-user-pools.md](cognito-user-pools.md) — the two Cognito user pools, one per role, and why not one pool with groups (TASK 2.2.1); amended by D-29 — the patient pool's own amendment section
- [lambda-authorizer.md](lambda-authorizer.md) — the shared Lambda authorizer verifying tokens from either pool (TASK 2.2.2)
- [patient-registration.md](patient-registration.md) — **superseded by D-29** — patient self-registration and the clinician approval lifecycle (TASK 2.2.3); the approval lifecycle itself is still current, the self-registration creation path is not
- [patient-account-provisioning.md](patient-account-provisioning.md) — D-29: staff-mediated patient account creation and password reset over WhatsApp, replacing self-registration; the approval step is unchanged
- [web-authentication.md](web-authentication.md) — the authenticated account shell: sign-in, the session, sign-out (TASK 2.2.4); amended by D-29 (a password on Cognito's page, not a one-time code)
- [clinician-accounts.md](clinician-accounts.md) — clinician account provisioning, and the two live bugs found provisioning the first real principal (TASK 2.4.1); amended by D-30 — no invite email, both steps built and live-verified end to end with a real synthetic test clinician
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
- [appointment-reminders.md](appointment-reminders.md) — the 1-hour reminder sweep, GSI4, and the first real SMS send (TASK 3.4.3); **deleted, not merely disabled, D-32 (2026-08-30)** — a clinician now reminds a patient over WhatsApp, by hand
- [content-assignment.md](content-assignment.md) — a clinician assigning existing content to a patient (TASK 3.5.1)
- [messaging.md](messaging.md) — rate-limited patient↔clinician messaging (TASK 3.6.1)

## Notifications

- [notifications.md](notifications.md) — the notification abstraction: email/SMS, defined degradation, never a silent drop (TASK 2.3.1)
- [sms-provider.md](sms-provider.md) — AWS End User Messaging as the real SMS provider, ADR-0008's rate correction (TASK 2.3.2); **unreachable since D-32 (2026-08-30)** — its one real caller (the reminder sweep) is deleted; kept in place, unused, not deleted
- [email-events.md](email-events.md) — SES bounce/complaint handling, the SNS event pipeline, its own confirmed subscription
- [workshop-confirmation-sms.md](workshop-confirmation-sms.md) — see Public site section above (also a notifications task)

## Video calling

- [video-signalling.md](video-signalling.md) — the WebSocket signalling channel: connect, disconnect, call authorisation, the relay (TASK 4.1.1, TASK 4.2.1, TASK 4.2.2)
- [video-calls.md](video-calls.md) — the peer connection, device check, ICE-failure fallback, TURN credentials, the relay cap, the join button (TASK 4.3.1, TASK 4.3.2, TASK 4.3.3, TASK 4.4.1, TASK 4.4.2, TASK 4.5.1)

## Phase 5 — capacity, security, accessibility, recoverability, cost

- [load-testing.md](load-testing.md) — the 10×-derived load harness, the real HTTP baseline run, and the cold-start p95 finding (TASK 5.1.1, TASK 5.1.2)
- [live-session-accessibility.md](live-session-accessibility.md) — the real, signed-in, live-session axe + keyboard sweep for the account shell (TASK 5.3.1, TASK 5.3.2)
- [restore-drill.md](restore-drill.md) — a real DynamoDB PITR restore and a real export restore, both executed and measured; D-22's own export layer named as missing, then built and drilled from (TASK 5.4.1)
- [backup-export.md](backup-export.md) — D-22's periodic export layer: a daily, GOVERNANCE-mode Object-Locked DynamoDB backup, built once `restore-drill.md` found it missing, deployed, and exercised for real
- [go-live.md](go-live.md) — the flag flip sequence, split into a public-site track and an LL-05/LL-06-gated patient-facing track, and the current live flag state (TASK 5.5.3)

Phase 5's security review (TASK 5.2.1) and DPIA update (TASK 5.2.2) live outside this directory by their own nature — `docs/plan/gate-g4-security-review.md` and `docs/compliance/dpia-skeleton.md` respectively, not duplicated here.

## What's still open, across every runbook above

A spot-check pass (not exhaustive — 51 files) found and closed three stale items this task's own writing exposed as already resolved: the `ndn-email-events` SNS subscription (confirmed live, [email-events.md](email-events.md)/[ses-production-access.md](ses-production-access.md)), the lambda authorizer's deferred token-based verification (proven as a side effect of the TASK 5.3.x live-session suite, [lambda-authorizer.md](lambda-authorizer.md)), and [g1-cutover.md](g1-cutover.md)'s own step 8 cost reconciliation (satisfied by TASK 5.5.1's account-wide pass). Everything else this pass checked was already accurately marked, open or closed.

Genuinely still open, owner-side, as of this pass (2026-08-28), **updated 2026-08-29 where TASK 5.5.3's own work closed or corrected an item below** — not stale otherwise, not this index's job to close further:

- **LL-01 (SES production access)** — denied 2026-08-21, [ses-production-access.md](ses-production-access.md). Blocks the clinician-invite-email check named in [web-authentication.md](web-authentication.md); no longer blocks a patient check — D-29 (2026-08-29) removed patient sign-in's own dependency on it, see [patient-account-provisioning.md](patient-account-provisioning.md).
- **D-29's staff-facing UI — built same day, 2026-08-29,** the day after this bullet first named it missing; corrected here rather than left stale. **Staff identity-verification training and the DPIA update remain not done**, by the owner's own deliberate choice named in [patient-account-provisioning.md](patient-account-provisioning.md): prove the technical mechanism with synthetic test patients first (now proven, live, end to end), defer legal/DPIA review until then. Not this index's job to close.
- ~~**LL-02 (UK SMS long code)** — not leased; AWS End User Messaging account confirmed still `SANDBOX` tier, 0 phone numbers, live-checked this pass. Blocks [sms-provider.md](sms-provider.md)'s real-account proof and [workshop-confirmation-sms.md](workshop-confirmation-sms.md).~~ **Closed as moot, D-32 (2026-08-30)** — the appointment reminder sweep, the only real caller SMS sending could ever have had, is deleted; there is nothing left for a leased number to serve. Corrected here rather than left stale.
- ~~**Cloudflare Realtime/Calls TURN key** — not provisioned; `/ndn/cloudflare-turn-api-token` confirmed absent from SSM.~~ **Closed, 2026-08-30** — the owner provisioned the "ndn-video-relay" TURN key in the Cloudflare Realtime dashboard; `CLOUDFLARE_TURN_KEY_ID` (`infra/src/config.ts`) and `/ndn/cloudflare-turn-api-token` (SSM SecureString) are both real. `video.turn.enabled` can now do something real once turned on, per [video-calls.md](video-calls.md)'s own sequence in [go-live.md](go-live.md).
- ~~**Real Turnstile widget + secret** — `site-config.ts` still runs Cloudflare's public test key.~~ **Closed, 2026-08-30** — the owner created the "NDN Site Widget" (hostnames: apex + `next.`); `turnstileSiteKey` (`apps/web/src/site-config.ts`) and `/ndn/turnstile-secret-key` (SSM SecureString) are both real. [testimonials.md](testimonials.md) is its only live caller since D-32 deleted the contact form.
- **The cold-start / feature-flag SSM latency finding** — priced, not fixed, [load-testing.md](load-testing.md)'s TASK 5.1.2 section. Owner decision named there.
- **LL-05 (DPIA) and LL-06 (solicitor sign-off, R-04)** — deliberately deferred by the owner until proven with synthetic patients (now proven, per D-29's 2026-08-29 status update); still open, and the standing gate on every patient-facing flag beyond the four already on for synthetic testing. The sequence itself — mechanism-proven and ready — is now documented in [go-live.md](go-live.md) (TASK 5.5.3); flipping any of it for a real patient still waits on these two.

## Do NOT

Delete or merge a runbook file to "clean up" — the append-only, never-remove-history discipline this codebase applies to data applies to documentation too, now for the first time. Extend a runbook in place (every existing file's own convention) or add a new one; never fold two into one.
