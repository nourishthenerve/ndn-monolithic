# Ephemeral per-PR environments (TASK 0.6.3)

**Date:** 2026-08-13 · **Task:** [05-execution-plan.md § TASK 0.6.3](../plan/05-execution-plan.md) · **Requirements:** §10 · **Decisions:** [D-19](../plan/01-decisions.md) · **Risks:** [R-08](../plan/02-risk-register.md) · **Depends on:** 0.6.2

## What this covers

D-19's last unbuilt layer of "zero staging plus a bad merge takes production down": a CI job that deploys a uniquely-named, real stack for every PR, proves it against the live URL (integration + contract + a11y), then destroys it — in the same run, even on failure. This closes Phase 0 (Gate G0).

## What was built

### `infra/src/web-stack.ts` — an `ephemeral` mode alongside the existing production shape

`WebStackProps` gains two optional fields, both `undefined`/`false` by default so production is byte-for-byte unaffected:

- **`ephemeral: boolean`** — when true, the `Distribution` gets no `domainNames`/`certificate` (CloudFront rejects a second distribution aliasing `next.nourishthenerve.com`, and there's no ACM certificate for a domain the stack never claims anyway) and serves on its own always-unique `*.cloudfront.net` domain instead, over CloudFront's own default certificate.
- **`prLabel: string`** (e.g. `pr-999`) — mixed into every explicit CloudWatch log group name in the stack (`/ndn/pr-999/health-function`, `/ndn/pr-999/smoke-test-function`, and since 2026-08-21 `/ndn/pr-999/site-deployment` — see [log-retention-volume-control.md](log-retention-volume-control.md#follow-up-2026-08-21--the-implicit-log-group-leak-gate-g1-4), which is also why `cdk destroy` now takes the bucket-deployment Lambda's logs with the stack instead of orphaning them). CloudWatch Logs group names are a flat per-account/region namespace, not scoped by CloudFormation stack — without this, two PR stacks deployed concurrently (two open PRs; different refs aren't cancelled by the workflow's own `concurrency` group) would collide on the second one's `CreateLogGroup` call.

`securityHeaders`/`distribution` construction moved earlier in the constructor (before `smokeTestFunction`) so the smoke test's `SITE_DOMAIN` env var can read `distribution.distributionDomainName` in ephemeral mode instead of the hardcoded production `DOMAIN_NAME` — otherwise correct in practice only by accident: CodeDeploy's `AfterAllowTraffic` hook (which is what actually invokes the smoke test) fires only on an *update* to an existing alias, never on a bare stack `CREATE`, and every ephemeral stack is created fresh and destroyed within the same run, never updated. Fixed anyway rather than left as a "trust me" comment on a value that would otherwise point at production's domain from inside a PR stack.

`infra/assets/site/index.html` gained a `<main>` landmark around its one paragraph — a real finding from wiring up the new a11y check below (axe-core's `region` rule), not a change made for its own sake.

### `infra/bin/app.ts` — `PR_NUMBER` branches the CDK app

When the `PR_NUMBER` env var is set (CI sets it to `github.event.number`), the app synthesizes **only** `WebStack`, with id `NdnWebStackPr${PR_NUMBER}` (`PR_STACK_ID_PREFIX` in `config.ts`), `ephemeral: true`, `prLabel: pr-${PR_NUMBER}` — no `BudgetStack` (a per-PR budget/alarm makes no sense for a stack that's gone within the same run). Otherwise, behaviour is exactly what it was before this task.

### `tests/pr-env/` — the integration + contract + a11y suite, against a live URL

A new, separate vitest project (`vitest.pr-env.config.ts`, `pnpm run test:pr-env`) — deliberately **not** picked up by the ordinary `pnpm run test`/`test:integration` gate (`tests/vitest.config.ts` is now scoped to `include: ['src/**/*.test.ts']` specifically so it can't), since these tests require a live deployed stack and would fail every ordinary CI run otherwise. `tests/pr-env/env.ts`'s `getBaseUrl()` reads `PR_ENV_BASE_URL`, set by the CI job right after `cdk deploy` returns the distribution's own domain — and throws immediately, with a clear message, if it's unset, rather than letting three unrelated `fetch` calls fail with a confusing network error.

- **`integration.test.ts`** — `/health` and `/` both return 200 over real HTTPS, with the expected content types.
- **`contract.test.ts`** + **`health-contract.ts`** — the first real use of Zod for "runtime validation at every boundary" (`docs/plan/00-conventions.md`): `/health`'s JSON body is parsed against a schema (`status: 'ok'`, non-empty `version`, ISO `timestamp`), so a silently renamed/dropped field fails here even though the status code stays 200.
- **`a11y.test.ts`** — fetches the served HTML, loads it into a `jsdom`-backed `Document`, and runs `axe-core` against it, asserting zero violations. `axe-core` is imported with a **dynamic** `import()` *inside* the test, after the JSDOM-derived `window`/`document` globals are assigned — confirmed empirically (see below) that axe-core reads those globals once, at its own module-evaluation time, not per call, so a normal static top-of-file import (evaluated by the module loader before the test body ever runs) captures them as `undefined` and every run throws `Required "window" or "document" globals not defined`. `color-contrast` and a couple of other checks land in axe's `incomplete` bucket rather than `violations` — jsdom has no real layout/rendering engine to compute against — which is why the test only asserts `violations`, not `incomplete`, is empty. This is a lightweight stand-in for the real-browser a11y suite TASK 1.1.3 (Phase 1) adds across every page; it exists now so the ephemeral-env pipeline has an a11y gate from day one rather than none until then.

### `.github/workflows/ci.yml` — the `pr-environment` job

Runs on `pull_request` once `quality` passes and code changed. Assumes `ndn-deploy-pr` via OIDC, `cdk deploy "NdnWebStackPr${PR_NUMBER}" --exclusively`, polls `/health` until the distribution actually serves (up to 5 minutes), runs `pnpm run test:pr-env` against it, then **always** (`if: always()`) runs `cdk destroy --exclusively --force` and asserts via `aws cloudformation describe-stacks` that this PR's own stack is gone (`NOT_FOUND` or `DELETE_COMPLETE`) — scoped to exactly this PR's stack name, not every `NdnWebStackPr*` stack in the account, since a second PR's job can legitimately be mid-deploy at the same moment (different ref, so not cancelled by the workflow's `concurrency` group).

**Landed informational-only** — included in `ci-summary`'s `needs` (so its result and duration are visible in the job summary) but deliberately excluded from the pass/fail gate loop, matching exactly the pattern `ci-pipeline.md` already used for `oidc-dry-run`'s own first landing: this is the first time `ndn-deploy-pr`'s OIDC trust and a full live CloudFront deploy/destroy cycle are exercised from an actual Actions run, not just a local admin-profile proof. See Owner actions below for promoting it once its first live run is confirmed green.

## The IAM design trade-off — explicitly reviewed, not a silent default

Real AWS investigation (see below) found that `cdk deploy` always routes stack operations through the account's bootstrap `cdk-hnb659fds-deploy-role` (`DeploymentActionRole`) — confirmed via CloudTrail, not assumed: every `CreateChangeSet`/`ExecuteChangeSet`/`DescribeStacks` call `ndn-deploy` has ever made ran as an *assumed* `DeploymentActionRole` session, never directly as `ndn-deploy` itself. That role's own policy is **not scoped by stack name** (`Resource: "*"` on `CreateStack`/`UpdateStack`/`DeleteStack`) and holds `iam:PassRole` to `cdk-hnb659fds-cfn-exec-role` — an **`AdministratorAccess`** execution role. Any principal that can assume `DeploymentActionRole` can therefore create/update/delete **any** stack in the account with full admin execution, not just a throwaway PR stack — the same risk shape TASK 0.2.1's `ndn-deploy` OIDC-trust fix eliminated (see `ci-pipeline.md`), one hop further away.

Two designs were weighed, put to the account owner explicitly (this is real, hard-to-reverse trust-boundary infrastructure — not a call to make silently):

1. **Full least-privilege** — a bespoke, narrowly-scoped CloudFormation execution role plus an IAM permissions-boundary on anything it creates, bypassing `cdk deploy`'s default admin role chain entirely. Real containment even against a future untrusted collaborator. Substantially more IAM engineering, and a real risk of a slow iterate-fail-fix cycle against a live account where each CloudFront create/delete attempt costs 5–15 minutes.
2. **Pragmatic now, harden later** — `ndn-deploy-pr` reuses the existing bootstrap `DeploymentActionRole`/`CloudFormationExecutionRole` path, same mechanism `ndn-deploy` uses for production. It can technically reach any stack. Chosen: **this repo has exactly one collaborator today (the account owner), who already holds full admin CLI credentials (`ndn-admin`) to this exact account directly** — a `pull_request`-triggered role with admin-execution capability adds zero real-world exposure beyond what already exists, and GitHub only runs `pull_request` workflows with OIDC/secrets for PRs from within this private repo (fork PRs on a private repo require existing collaborator access in the first place). Matches this repo's own precedent of explicitly deferring hardening that only matters once a second collaborator exists (see `ci-pipeline.md`'s branch-protection and org-2FA decisions).

**Decision (owner-approved, 2026-08-13): option 2.** `ndn-deploy-pr`'s own IAM policy is still meaningfully narrower than `ndn-deploy`'s — no `PowerUserAccess`, no permissions of its own beyond `sts:AssumeRole` on exactly the two bootstrap roles `ndn-deploy` itself uses (`cdk-hnb659fds-deploy-role-...`, `cdk-hnb659fds-file-publishing-role-...`) — and the CI job additionally scopes every `cdk deploy`/`cdk destroy` call to `--exclusively` its own PR stack, as a second, workflow-level layer of the same intent. The residual gap — a compromised/malicious PR could, inside an allowed `NdnWebStackPr*`-named stack, use the shared admin execution role for something arbitrary — is real and explicitly not closed by this task.

**Flagged for revisit, same trigger point already tracked elsewhere in this repo:** before a second collaborator gets write access to this repository, replace `ndn-deploy-pr`'s reuse of the shared bootstrap execution role with a purpose-built, narrowly-scoped one (option 1 above).

## `ndn-deploy-pr` — what was actually created (real AWS, `ndn-prod`/`357601815388`)

```bash
aws --profile ndn-prod iam create-role --role-name ndn-deploy-pr \
  --assume-role-policy-document file://ndn-deploy-pr-trust.json --max-session-duration 3600
aws --profile ndn-prod iam put-role-policy --role-name ndn-deploy-pr \
  --policy-name AssumeCdkBootstrapRolesOnly --policy-document file://ndn-deploy-pr-policy.json
```

Trust policy — same shape as `ndn-deploy`'s, `sub` scoped to the `pull_request` OIDC subject in the immutable-ID format `ci-pipeline.md`'s own follow-up fix already established is required (`repo:nourishthenerve@252558973/ndn-monolithic@1327118618:pull_request`):

```json
{
  "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::357601815388:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike": { "token.actions.githubusercontent.com:sub": "repo:nourishthenerve@252558973/ndn-monolithic@1327118618:pull_request" }
  }
}
```

The only inline policy — no managed policy attached, no `PowerUserAccess`:

```json
{
  "Sid": "AssumeCdkBootstrapRolesOnly",
  "Effect": "Allow",
  "Action": "sts:AssumeRole",
  "Resource": [
    "arn:aws:iam::357601815388:role/cdk-hnb659fds-deploy-role-357601815388-eu-west-2",
    "arn:aws:iam::357601815388:role/cdk-hnb659fds-file-publishing-role-357601815388-eu-west-2"
  ]
}
```

**Verified with the policy simulator, against the real IAM state:**

```text
$ aws --profile ndn-prod iam simulate-principal-policy --policy-source-arn .../role/ndn-deploy-pr \
    --action-names sts:AssumeRole --resource-arns .../cdk-hnb659fds-deploy-role-... .../cdk-hnb659fds-file-publishing-role-...
cdk-hnb659fds-deploy-role-357601815388-eu-west-2            allowed
cdk-hnb659fds-file-publishing-role-357601815388-eu-west-2   allowed

$ aws --profile ndn-prod iam simulate-principal-policy --policy-source-arn .../role/ndn-deploy-pr \
    --action-names sts:AssumeRole --resource-arns .../cdk-hnb659fds-cfn-exec-role-...
cdk-hnb659fds-cfn-exec-role-357601815388-eu-west-2   implicitDeny

$ aws --profile ndn-prod iam simulate-principal-policy --policy-source-arn .../role/ndn-deploy-pr \
    --action-names cloudformation:CreateStack cloudformation:UpdateStack cloudformation:DeleteStack s3:PutObject iam:CreateUser iam:CreateRole
cloudformation:CreateStack   implicitDeny
cloudformation:UpdateStack   implicitDeny
cloudformation:DeleteStack   implicitDeny
s3:PutObject                 implicitDeny
iam:CreateUser               implicitDeny
iam:CreateRole               implicitDeny
```

`ndn-deploy-pr` itself can do exactly one thing directly: assume the same two bootstrap roles `ndn-deploy` already uses. Everything else — including calling CloudFormation at all — only happens once it has assumed `DeploymentActionRole`, per the design trade-off above.

## Verification

### Local — synth + unit tests, zero live AWS calls

`infra/src/web-stack.test.ts`'s new `describe('WebStack — ephemeral per-PR mode (TASK 0.6.3)')` block proves, from the synthesized template: no `Aliases`/`ViewerCertificate` on the ephemeral distribution; no ACM certificate ARN referenced anywhere in it; every log group name carries the given `prLabel`; production mode (no `ephemeral` prop) is byte-for-byte unaffected — still the fixed domain, certificate, and log group names.

`tests/pr-env/*.test.ts` were proven for real against a local static HTTP server standing in for a deployed stack (`PR_ENV_BASE_URL=http://127.0.0.1:...`) before ever touching AWS — all 4 tests (2 integration, 1 contract, 1 a11y) passed, including the axe-core-globals-must-be-set-before-dynamic-import finding documented above, discovered by first reproducing the failure directly in `node -e` against `axe-core`/`jsdom` outside any test framework.

```bash
pnpm run lint && pnpm run typecheck && pnpm run test && pnpm run test:integration && pnpm run test:coverage && pnpm run audit
```

All green — infra 50 tests (up from 42), coverage 99.68% statements / 96.32% branches (thresholds are 80%). `actionlint .github/workflows/ci.yml` clean.

### Real AWS — the full deploy → test → destroy cycle, proven end to end before wiring CI

Run directly against `ndn-prod` (admin profile), `PR_NUMBER=999` — the same "prove it manually first, before CI ever touches it" precedent `iac-baseline.md` established for the very first stack:

```text
$ AWS_PROFILE=ndn-prod npx cdk deploy NdnWebStackPr999 --require-approval never --outputs-file /tmp/pr999-outputs.json
NdnWebStackPr999: 32/32 resources — CREATE_COMPLETE (255.46s)

Outputs:
NdnWebStackPr999.DistributionDomainName = d2ol4k9wt7ofuu.cloudfront.net
NdnWebStackPr999.HealthDeploymentGroupName = NdnWebStackPr999-HealthDeploymentGroup18E3B547-YVTUaJ86c67Z
NdnWebStackPr999.HttpApiUrl = https://cdd508u3z8.execute-api.eu-west-2.amazonaws.com
NdnWebStackPr999.SiteBucketName = ndnwebstackpr999-sitebucket397a1860-oldfzjmhiugi

$ curl -s https://d2ol4k9wt7ofuu.cloudfront.net/health
{"status":"ok","version":"local","timestamp":"2026-08-13T09:33:02.481Z"}

$ curl -sI https://d2ol4k9wt7ofuu.cloudfront.net/
HTTP/2 200
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
content-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'
x-content-type-options: nosniff
strict-transport-security: max-age=31536000; includeSubDomains; preload

$ curl -sI https://ndnwebstackpr999-sitebucket397a1860-oldfzjmhiugi.s3.eu-west-2.amazonaws.com/index.html
HTTP/1.1 403 Forbidden
```

Confirms the ephemeral-mode changes hold under real CloudFormation: no `next.nourishthenerve.com` alias conflict with the live production distribution (which kept serving throughout — untouched, different stack entirely), the same security-header/OAC/TLS shape as production, and a distinct, CDK-auto-uniquified physical name for every resource (bucket, log groups, etc.) with no collision against `NdnWebStack`'s own.

**`pnpm run test:pr-env` against the real URL** (`PR_ENV_BASE_URL=https://d2ol4k9wt7ofuu.cloudfront.net`): all 4 tests passed — 2 integration, 1 contract (the Zod schema against the real `/health` body), 1 a11y (axe-core against the real served HTML, 0 violations).

```text
$ AWS_PROFILE=ndn-prod npx cdk destroy NdnWebStackPr999 --force
NdnWebStackPr999: DELETE_COMPLETE

$ aws --profile ndn-prod cloudformation describe-stacks --stack-name NdnWebStackPr999
An error occurred (ValidationError): Stack with id NdnWebStackPr999 does not exist
```

Zero standing cost, proven for real — the exact mechanism the CI job's own final step re-checks on every PR.

> **Finding, 2026-08-21 — that final step cannot actually fail.** Noticed while fixing the log-group leak ([log-retention-volume-control.md](log-retention-volume-control.md#follow-up-2026-08-21--the-implicit-log-group-leak-gate-g1-4)) and **not fixed here**, because the fix is an IAM decision, not a workflow edit. `ndn-deploy-pr` holds `sts:AssumeRole` on the two bootstrap roles and nothing else — `aws iam simulate-principal-policy` returns `implicitDeny` for `cloudformation:DescribeStacks` against `stack/NdnWebStackPr*`. The assertion step runs that call with the job's *own* credentials, so it gets `AccessDenied`, which `2>/dev/null || echo "NOT_FOUND"` converts into the success case: PR #47's run printed `NdnWebStackPr47: NOT_FOUND — zero standing cost confirmed` whether or not the stack was still standing. (It genuinely was gone that run — `cdk destroy` had just reported `DELETE_COMPLETE` — so nothing leaked; the check simply proves nothing.) Two ways to make it real, both needing an owner call: grant `ndn-deploy-pr` read-only `cloudformation:DescribeStacks` scoped to `stack/NdnWebStackPr*`, or run the check through the bootstrap deploy role the job already assumes. A third option — failing the step loudly on any error that isn't "stack does not exist" — turns every PR red until one of the first two lands, which is honest but blocks merges, so it is a decision rather than a drive-by fix.

## Cost

£0.00 standing for everything that matters at scale — every resource an ephemeral stack creates is destroyed in the same CI run, confirmed above (`cdk destroy` → `DELETE_COMPLETE` → `describe-stacks` reports the stack doesn't exist). Transient cost while a PR's job runs (CloudFront requests during the ~5-minute create/delete window observed above, a handful of Lambda invocations, S3 PUT/GETs) is negligible and within always-free tiers at this volume.

**One honest exception:** `SiteBucket` carries `RemovalPolicy.RETAIN` — the same policy every bucket in this repo uses, "never auto-deleted by code" (`docs/plan/00-conventions.md`'s prohibition, `web-stack.ts`'s own existing comment) — so `cdk destroy` reports it `DELETE_SKIPPED`, and its one placeholder `index.html` object survives every ephemeral run, confirmed above (`aws s3api list-objects-v2` still lists it after the stack was gone). That means one small, empty-ish bucket accumulates per PR, forever, at effectively unmeasurable storage cost (a few hundred bytes each) but not literally zero. Deliberately not changed to `RemovalPolicy.DESTROY` + `autoDeleteObjects` for ephemeral stacks — that would need a delete-capable custom-resource Lambda purely to shave a cost this small, trading a real (if narrow) new deletion capability for no meaningful saving, and would make the one bucket policy in this repo behave differently depending on which stack created it. Left as-is and disclosed here rather than silently claimed away.

## Not done in this task (explicitly out of scope)

- **The bespoke least-privilege execution role** (design option 1 above) — explicitly deferred, flagged for revisit before a second collaborator gets repo access.
- **A scheduled/periodic sweep for orphaned stacks** — `always()` steps reliably run on ordinary failures and on this workflow's own `cancel-in-progress` cancellations, but not if a runner is hard-killed mid-job. Not built here; the DoD's literal bar (assert the stack is gone within the same run) is met either way.
- **Promoting `pr-environment` into `ci-summary`'s required gate** — was an owner action here; **done 2026-08-21**, see "Paused, then resumed" below.

## Paused (2026-08-13), then resumed and made gating (2026-08-21)

**Paused 2026-08-13 (owner decision).** The job was disabled by appending `&& false` to its `if:` condition. Rationale: it was already informational-only (see above — never in `ci-summary`'s required-gate loop), but a full CloudFront distribution create → test → destroy cycle still costs ~15–30 minutes of wall-clock CI time on every PR. During that phase of the plan (many small, sequential milestone-task PRs — see `docs/plan/05-execution-plan.md`'s Phase 1 task list), the wait wasn't worth paying on every PR for a check that was already advisory.

**Resumed 2026-08-21, and promoted into the required gate in the same change** (Gate G1 action item 2, `docs/plan/gate-g1-report.md` §7). The pause lasted eight days and cost more than the CI minutes it saved: this job is the only place `tests/pr-env/a11y-full.test.ts` and `keyboard.test.ts` run, so every Phase 1 UI task from TASK 1.2.1 onward — nav, footer, legal pages, cookie consent, blog, contact, testimonials, workshops — merged with no axe or keyboard check at all. Run by hand for the gate, the keyboard suite failed on 4 of 15 routes.

Both halves of the "Owner actions" item below landed together, as it always said they should: the `&& false` is gone from `ci.yml`, and `pr-environment` is now inside `ci-summary`'s `for r in ...` loop, so an a11y or keyboard regression blocks a merge instead of being reported after the fact. What made that safe to do in one step rather than the usual watch-then-promote sequence is that the suite was first proved green against the live site (`PR_ENV_BASE_URL=https://next.nourishthenerve.com pnpm run test:pr-env` → 18 vitest + 29 Playwright, all passing) on the same branch that fixed it.

**Cost of the resume, stated plainly:** every PR that touches code now pays the ~15–30 minute distribution create/destroy cycle again. Docs-only PRs are unaffected — the `changes.outputs.code` path filter still short-circuits the job. If that wall-clock cost has to be cut again, cut it by narrowing *what* the job deploys, not by turning the a11y gate off; the eight-day pause is the argument against the second option.

**What the first re-enabled run found, within 15 minutes.** PR #47's own `pr-environment` job failed at `cdk deploy`: `AWS::SES::ConfigurationSet 'ndn-email' already exists`, plus both `ndn-email-*` alarms. TASK 1.4.1/1.5.2's email-event pipeline (2026-08-21, [email-events.md](email-events.md)) had landed while this job was paused and created account-global fixed-name resources unconditionally in `WebStack` — the same stack this job deploys per PR. Nothing was broken in production and the `always()` destroy step left no orphan, but **the ephemeral environment had been non-deployable for a day and nothing said so.** That is the concrete cost of a paused gate, and it is the answer to "was re-enabling worth the CI minutes". Fixed on the same branch; see email-events.md for why the fix is a guard rather than per-PR names.

**Standing rule this implies:** anything added to `WebStack` with a fixed physical name is a per-PR collision. Ephemeral mode already scopes log groups and SSM paths by `prLabel`; for account-global resources that make no sense per PR (budgets, reputation alarms, an SNS topic with a human subscriber), guard on `props.ephemeral` instead and assert the absence in `web-stack.test.ts`.

**To pause again (not recommended — read the paragraph above first):** append `&& false` to `pr-environment`'s `if:` condition in `.github/workflows/ci.yml` **and** remove it from `ci-summary`'s `for r in ...` loop in the same change, or the summary job will fail every PR on a job that never ran.

## Owner actions

1. ~~**Watch the first real `pr-environment` run** on an actual PR, then promote it into `ci-summary`'s required gate~~ — **done 2026-08-21** (see above). The job is re-enabled and gating; the first PR to run it is the one that made this change.
2. **Revisit the IAM design trade-off above** before granting a second collaborator write access to this repository.

## Rollback

- **`ndn-deploy-pr` role:** `aws --profile ndn-prod iam delete-role-policy --role-name ndn-deploy-pr --policy-name AssumeCdkBootstrapRolesOnly` then `iam delete-role --role-name ndn-deploy-pr`. Deleting it only removes the ability to run the `pr-environment` job — no other role or production path depends on it.
- **`WebStack`'s ephemeral mode / `bin/app.ts`'s `PR_NUMBER` branch:** revert the commit. Production's own deploy path (`PR_NUMBER` unset) is unchanged either way, so no redeploy of `NdnWebStack`/`NdnBudgetStack` is required to roll this back.
- **`ci.yml`'s `pr-environment` job:** revert the commit that added it — it was additive-only (a new job plus two `needs`/gate-echo lines), no existing job's behaviour changed. Since 2026-08-21 the job is also in `ci-summary`'s required-gate loop, so a rollback must remove it from that loop too (see "To pause again" above).
- **Any stray `NdnWebStackPr*` stack** (e.g. from a hard-killed CI run): `AWS_PROFILE=ndn-prod npx cdk destroy NdnWebStackPr<N> --exclusively --force` from `infra/`, or delete via the CloudFormation console. No data is at risk — every ephemeral stack holds only the placeholder page and a health-check Lambda.
