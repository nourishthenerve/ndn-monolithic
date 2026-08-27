# Full-codebase security review (TASK 5.2.1)

**Date:** 2026-08-27 · **Task:** [05-execution-plan.md § TASK 5.2.1](05-execution-plan.md) · **Scope:** every IAM role/policy in `ndn-prod`, every externally-reachable endpoint, every secret's storage posture, the dependency tree — as a whole, not one gate's diff.

## Why this review, now

Every gate since G0 has run a *scoped* security check — that gate's own diff, that gate's own dependency audit, an authorisation-boundary re-audit against the current entity set. None has looked at the accumulated whole: four phases and nine merged video-calling tasks of surface, reviewed together for the first time, before Phase 6 adds a second consumer of the same API. This review is that pass — live against the real `ndn-prod` account (357601815388), not only against synthesized templates.

## Findings

Ranked by severity. Two carry a code fix landed in this same PR (`docs/5-2-1-security-review` branch); the rest are either already-correct (recorded so, not re-litigated) or coordination items for a later task.

### 1. [MEDIUM, fixed] DynamoDB table had no native deletion protection

`NdnDataStack`'s table — the one table holding every patient, clinical, appointment, message and audit row this system has — had `removalPolicy: RemovalPolicy.RETAIN` but no `deletionProtection`. `RETAIN` only governs what *CloudFormation* does; it does nothing against a direct `aws dynamodb delete-table` call by a principal with the permission (`ndn-deploy`, `ndn-admin` — neither is subject to the application-Lambda-scoped IAM Deny in `guardrails.ts`). `auth-stack.ts`'s own Cognito pools already state the exact reasoning that applies equally here: *"Neither is sufficient alone — deletion protection can be turned off by an UpdateUserPool call, and RETAIN only governs what CloudFormation does."* TASK 1.3.1 (this table) predates TASK 2.2.1 (where that two-layer pattern was established) by weeks and was never revisited — exactly the kind of gap a holistic review, rather than a per-task diff, exists to catch.

**Fix:** `deletionProtection: !props.ephemeral` added to `DataStack`'s table (`infra/src/data-stack.ts`). `false` for the load-test copy (TASK 5.1.1), which must stay freely destroyable. Test added (`data-stack.test.ts`): production asserts `DeletionProtectionEnabled: true`, the ephemeral copy asserts `false`. **Lands in production on merge**, via the same CI deploy pipeline every other infra change in this repo uses — not applied out-of-band.

### 2. [LOW–MEDIUM, fixed] 76 orphaned S3 buckets from every past ephemeral PR run

`web-stack.ts`'s `SiteBucket`/`MediaBucket` used `removalPolicy: RemovalPolicy.RETAIN` **unconditionally** — including for `WebStack`'s own `ephemeral` (per-PR) mode, added at TASK 0.6.3. `cdk destroy` (the CI job's own teardown step) orphans a RETAIN-policy resource rather than deleting it, and the CI job's "zero standing cost" assertion checks only that the *stack* reaches `NOT_FOUND` — never whether a RETAIN resource inside it survived. Result, confirmed live: **76 orphaned buckets**, one or two per ephemeral PR run back to PR #23, none ever caught. Total content: ~16.2 MB across 76 buckets (43 non-empty), all built static-site output or empty media buckets — no patient/clinical data (this is `WebStack`'s own site/media storage, never `DataStack`'s table). Dollar impact negligible (a fraction of a cent/month); the real finding is the unbounded, silently-growing accumulation pattern, and that nothing in this pipeline was positioned to catch it.

**Fix:** `removalPolicy: props.ephemeral ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN` plus `autoDeleteObjects: props.ephemeral` on both buckets (`infra/src/web-stack.ts`) — closes it for every future PR. Tests added confirming both shapes. **Remediated directly, live, under this repo's standing authority to remove unneeded infrastructure** (these are ephemeral CI build artifacts, not stored patient/clinical/financial data): all 76 buckets emptied (all object versions and delete markers, since versioning is enabled) and deleted via `boto3`, confirmed via `aws s3api list-buckets` — only the 4 legitimate buckets (CDK bootstrap assets, CloudTrail, production Site/Media) remain. One leftover log group from the same era, predating the shared `/ndn/pr-env/site-deployment` fix (`/ndn/pr-48/site-deployment`, already 14-day-retained, harmless but same root cause), removed alongside it.

### 3. [LOW, named not fixed] `autoDeleteObjects`'s own singleton has no explicit log group, and this repo's own guard against that doesn't see it

Finding #2's fix uses CDK's built-in `Bucket.autoDeleteObjects`, whose custom-resource Lambda (`Custom::S3AutoDeleteObjectsCustomResourceProvider`) is built inside `aws-cdk-lib/core` via a raw `CfnResource`, not `aws-cdk-lib/aws-lambda`'s `CfnFunction` class — and exposes no public prop for an explicit log group. Two consequences, both confirmed against the real synthesized template:

- `log-retention.ts`'s `ExplicitLambdaLogGroupAspect` — built specifically to fail synth on exactly this failure mode, after `BucketDeployment`'s own custom resource leaked one orphaned log group per ephemeral PR stack (2 at Gate G0, 13 by the time it was fixed) — checks `node instanceof CfnFunction` and does not match this construct, so it silently passes.
- `web-stack.test.ts`'s own, more precise test (`leaves no Lambda in the stack relying on CloudWatch's implicit group`, which checks the synthesized `LoggingConfig` property directly) **did** catch it — failing until explicitly, narrowly exempted by exact logical-id prefix, with a comment explaining why, rather than weakened generally.

Net effect: every ephemeral stack that is destroyed will create one new, small, infinite-retention log group for this Lambda (invoked only at delete time — a handful of log lines, not a per-deploy stream). Real, but bounded and low-volume, unlike `BucketDeployment`'s own now-fixed leak which fired on every deploy. **Not fixed in this task** — no supported CDK API exists to attach a log group to this specific internal construct today (confirmed by reading `aws-cdk-lib`'s own `Bucket`/`CustomResourceProvider` type declarations); closing it for real needs either an upstream CDK fix or widening `ExplicitLambdaLogGroupAspect` to match by CloudFormation resource type (`AWS::Lambda::Function`) rather than TS class — a deeper, riskier change than this review's own scope. `docs/runbooks/aws-account-baseline.md` names the periodic manual check (`aws logs describe-log-groups --query "logGroups[?retentionInDays==null]"`) until one of those lands.

### 4. [INFO, coordination] Four SSM secrets referenced by flag-gated Lambdas are not yet provisioned

`aws ssm describe-parameters` shows exactly one parameter in the account (`/cdk-bootstrap/hnb659fds/version`) — none of `/ndn/turnstile-secret-key`, `/ndn/cloudflare-turn-api-token`, `/ndn/stripe-secret-key`, `/ndn/stripe-webhook-secret` exist yet. Each is already individually documented as an owner action in its own task's runbook (`contact-form.md`, `video-calls.md`, `stripe-checkout-registration.md`), and this is correct today — every flag that would read one (`contact.form.enabled`, `video.turn.enabled`, `payments.stripeCheckout.enabled`) is off. **Not a defect** — a coordination gap: nothing currently lists all four together as a single pre-go-live checklist. **Recommendation, not a fix:** TASK 5.5.3's go-live sequence should explicitly check each secret exists before flipping the flag that reads it, not rely on four separately-discovered runbook mentions.

## Confirmed clean (no finding — recorded so it isn't re-checked from scratch next time)

- **IAM, account-wide.** `ndn-break-glass`: MFA-required trust, zero attached/inline policies — confirmed live, matches its own documented by-design state since Gate G0/G1 (`iam-deny-guardrails.md`). `ndn-ci-readonly`: two inline policies, both `iam:Simulate*` only, one scoped to exactly `ndn-deploy`'s ARN — genuinely read/simulate-only. `ndn-deploy`/`ndn-deploy-pr`: unchanged, OIDC-trust scoped as documented. Every one of the 33 Lambda execution roles is CDK-managed, per-function, least-privilege — no shared/broad role found. One IAM user (`ndn-admin`) — the documented human operator.
- **Every externally-reachable route**, live (`aws apigatewayv2 get-routes`), cross-checked byte-for-byte against `route-protection.ts`'s `PUBLIC_ROUTE_KEYS`: exactly 13 `NONE`-authorization routes exist, and all 13 are named in `PUBLIC_ROUTE_KEYS` — an exact match, no extra public route on either side. Every other HTTP route uses the real Lambda authorizer (`CUSTOM`). The WebSocket API's `$connect` uses the real connect authorizer; `$disconnect`/`$default` correctly show `NONE` at the API Gateway layer (WebSocket protocol has no per-message re-auth) and rely on the application-layer `CALL#` participation check (TASK 4.2.1/4.2.2) instead — by design, not a gap. Access logging on the WebSocket stage is confirmed off (the token rides in the connect URL).
- **Cognito.** Both pools show `DeletionProtection: ACTIVE` live. `ndn-clinicians`: `MfaConfiguration: ON`. `ndn-patients`: `OFF` — both match D-09's design exactly.
- **CloudFront.** `MinimumProtocolVersion: TLSv1.2_2021`, default viewer policy `redirect-to-https`.
- **S3.** Every bucket in the account (post-cleanup) has full `PublicAccessBlockConfiguration` (all four flags true).
- **CloudTrail.** Multi-region, log-file-validation enabled, actively logging.
- **Dependencies.** `pnpm audit --audit-level=high`: no known vulnerabilities. The known `stripe@22.5.0` dependency behaviour (`gate-g3-report.md` §6a) re-checked — no new instance, still the one already-recorded, non-actionable finding.
- **Budget.** $0.492 / $24.21 month-to-date — unchanged from Gate G4, healthy.

## Files changed by this review

- `infra/src/data-stack.ts` — `deletionProtection` added to the table (finding #1).
- `infra/src/web-stack.ts` — `SiteBucket`/`MediaBucket` `removalPolicy`/`autoDeleteObjects` corrected for ephemeral mode (finding #2).
- `infra/src/data-stack.test.ts`, `infra/src/web-stack.test.ts` — tests for both fixes, plus the narrow, documented exemption for finding #3.
- `docs/plan/gate-g4-security-review.md` — this document.
- Live account remediation (no code, not reflected in any diff): 76 orphaned S3 buckets and 1 leftover orphaned log group deleted from `ndn-prod`.

## What this review does not claim

Not a penetration test, not a DPIA (TASK 5.2.2's own, narrower job — updating the skeleton, not completing it), not a check of anything outside `ndn-prod` (357601815388) or this repository's own source. `LL-05`/`LL-06` (DPIA completion, solicitor sign-off on R-04) remain the owner's own actions, unchanged by anything here.
