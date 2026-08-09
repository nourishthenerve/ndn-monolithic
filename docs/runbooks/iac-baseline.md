# IaC baseline — DNS, certificate, CDN, storage, health check (TASK 0.4.1)

**Date:** 2026-08-09 · **Task:** [05-execution-plan.md § TASK 0.4.1](../plan/05-execution-plan.md) · **Requirements:** C-07, C-08, NFR-01 · **Depends on:** 0.2.1, 0.3.2

## What this covers

The first CDK stack (`infra/src/web-stack.ts`, `NdnWebStack`) that deploys real, billable resources to `ndn-prod` (`357601815388`): an S3 site bucket, a CloudFront distribution, an HTTP API + health-check Lambda behind it, and a security response-headers policy — served at a **staging hostname only**, `next.nourishthenerve.com`. The live apex site is untouched.

## Cross-account DNS: why this task has manual steps

The `nourishthenerve.com` Route 53 hosted zone (`Z09601252VHSWVDDK2RH4`) lives in account `803129122420` — the pre-existing account that also holds islamicmaps (unrelated, not touched) and the legacy brochure site (`docs/runbooks/legacy-estate.md`). It is **not** in `ndn-prod`, where CI's `ndn-deploy` OIDC role and every other piece of this stack live. `docs/plan/03-cost-model.md` budgets exactly one existing Route 53 zone, confirming the intent was always to keep using this zone, not migrate it.

Consequence: two DNS record additions — the ACM DNS-validation CNAME and the final `next.nourishthenerve.com` record — are cross-account and can't be done by `ndn-deploy`. Both were added by hand, once, using the `default` AWS CLI profile (root of `803129122420`). Both are **additive only** — the apex and `www` records were never touched. Everything else in this task (the CDK stack itself) deploys through CI via OIDC, matching the DoD.

## What was built

- **`infra/src/config.ts`** — checked-in, non-secret constants: `DOMAIN_NAME`, `ACCOUNT_ID`, `REGION`, and `CERTIFICATE_ARN` (see below). ARNs aren't secret — same reasoning `docs/runbooks/ci-pipeline.md` already applies to inlining role ARNs.
- **`infra/src/web-stack.ts`** (`WebStack`) —
  - S3 bucket: versioned, `BLOCK_ALL` public access, SSL-enforced, `RemovalPolicy.RETAIN` (never auto-deleted, matching every other protected resource in this repo).
  - CloudFront `Distribution`, `PriceClass_100`, S3 origin via **Origin Access Control** (`S3BucketOrigin.withOriginAccessControl`) — no public S3 access, no legacy OAI.
  - `ResponseHeadersPolicy`: HSTS (1yr, includeSubDomains, preload), CSP, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, Referrer-Policy — attached to every behavior.
  - HTTP API (`HttpApi`) + `NodejsFunction` (`services/api/src/health.ts`, arm64, Node 22) behind a `/health` CloudFront behavior with `CachePolicy.CACHING_DISABLED` (R-14: no-store, matching "no patient data traverses CloudFront" even though `/health` carries none). Same-origin API, per D-08/ADR-0003.
  - `BucketDeployment` pushing `infra/assets/site/index.html` (a placeholder "it's alive" page — the real frontend is TASK 1.1.1, Phase 1), with CloudFront invalidation on deploy.
  - Stack outputs: `DistributionDomainName`, `SiteBucketName`, `HttpApiUrl`.
- **`services/api/src/health.ts`** — Lambda handler returning `{ status, version, timestamp }`. `version` reads `process.env.DEPLOY_VERSION` (CDK sets this from `GITHUB_SHA`, which GitHub Actions runners populate automatically — no explicit wiring needed in the workflow), so `/health` proves *which commit* is actually live; falls back to `'local'` for manual deploys. `timestamp` comes from an injected `Clock` (docs/plan/00-conventions.md: "time is injectable — no test reads the wall clock"), matching the existing `Clock`/`systemClock` pattern in `services/api/src/clock.ts`.
- **`.github/workflows/ci.yml`** — new `deploy` job: `needs: [changes, quality]`, runs only on `push` to `main` with code changes, assumes `ndn-deploy` via OIDC (already scoped to `ref:refs/heads/main` since the TASK 0.2.1 security fix), runs `pnpm run deploy` (`cdk deploy --require-approval never --all`) from `infra/`. `ci-summary` gates on it (`success` or `skipped` — skipped is correct on `pull_request` events, same pattern as `oidc-dry-run`).

## Why `guardrails.ts`'s runtime-role deny isn't wired to the site bucket

`attachDestructiveActionGuardrail` (TASK 0.3.2) denies delete rights to a specific *runtime* role. The health Lambda never touches S3 — it returns a static JSON payload. The only writer to the site bucket is CDK's own `BucketDeployment` custom resource, which needs `s3:DeleteObject` to prune superseded build assets on each deploy (`Prune: true`, the default). That's ordinary deploy hygiene, not deletion of "patient, clinical, content or media data" (`docs/plan/00-conventions.md`'s prohibition) — this bucket holds nothing but built static assets, and stays versioned regardless. Real wiring of the guard lands when a genuine runtime role with bucket/table access exists (Phase 2/3 — a media bucket, a DynamoDB table).

## Manual AWS steps (cannot be done via CI/OIDC — see above)

### 1. ACM certificate, requested and DNS-validated

```bash
aws --profile ndn-prod acm request-certificate \
  --domain-name next.nourishthenerve.com --validation-method DNS --region us-east-1
# -> arn:aws:acm:us-east-1:357601815388:certificate/b1f9e01e-ab10-43b8-944a-6c0ccfffacb5

aws --profile ndn-prod acm describe-certificate \
  --certificate-arn arn:aws:acm:us-east-1:357601815388:certificate/b1f9e01e-ab10-43b8-944a-6c0ccfffacb5 \
  --region us-east-1 --query 'Certificate.DomainValidationOptions'
# -> CNAME _429359320b68325a7587cc168adc3028.next.nourishthenerve.com.
#      -> _3ba941437d40be275493a8210a4bef5c.jkddzztszm.acm-validations.aws.
```

Validation CNAME added to the `nourishthenerve.com` zone (`803129122420`, `default` profile) via `route53 change-resource-record-sets` (`UPSERT`, single record, apex/`www` untouched). Validated near-instantly: `describe-certificate` → `Status: ISSUED`.

No CDK stack is deployed to `us-east-1` — the cert is imported into `WebStack` (region `eu-west-2`) via `Certificate.fromCertificateArn(...)`, a plain ARN reference. This sidesteps CDK's `crossRegionReferences` machinery entirely, and means the CI `deploy` job never blocks on a cross-account DNS record it structurally cannot create.

### 2. `cdk bootstrap`, one-time, `ndn-prod`/`eu-west-2`

```bash
AWS_PROFILE=ndn-prod npx cdk bootstrap aws://357601815388/eu-west-2
```

`ndn-deploy`'s `PowerUserAccess` explicitly excludes IAM management (`docs/runbooks/aws-account-baseline.md`), and bootstrap creates IAM roles (`FilePublishingRole`, `CloudFormationExecutionRole`, …) plus the CDK asset S3 bucket — it structurally cannot run via the CI OIDC role. Same one-time-admin-bootstrap pattern as TASK 0.1.1. No bootstrap was needed in `us-east-1` — no stack deploys there.

### 3. Initial deploy, run directly (admin profile), before wiring CI

```bash
AWS_PROFILE=ndn-prod npx cdk deploy --require-approval never --all
```

Run this way first — not through CI — because CloudFront distribution creation takes 5–15 minutes per attempt, and debugging a first-ever infrastructure deploy through CI round-trips would be slow. Real deploy, real account, real resources: `NdnWebStack` reached `CREATE_COMPLETE` (19/19 resources, ~5 minutes total, mostly the CloudFront distribution's eventual-consistency wait).

```text
Outputs:
NdnWebStack.DistributionDomainName = dbn8dfhgi712k.cloudfront.net
NdnWebStack.HttpApiUrl = https://tow9lat993.execute-api.eu-west-2.amazonaws.com
NdnWebStack.SiteBucketName = ndnwebstack-sitebucket397a1860-r7jiskyi2d4j
```

### 4. `next.nourishthenerve.com` alias record

Once the distribution's domain name was known (above), a CNAME was added to the same zone (`803129122420`, `default` profile) — a subdomain, so a plain CNAME is valid DNS (unlike the apex, which cannot carry one):

```bash
# next.nourishthenerve.com. CNAME -> dbn8dfhgi712k.cloudfront.net (TTL 300)
```

## Verification (real AWS, 2026-08-09)

```text
$ curl -sI https://next.nourishthenerve.com/
HTTP/2 200
content-type: text/html
x-frame-options: DENY
referrer-policy: strict-origin-when-cross-origin
content-security-policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-ancestors 'none'
x-content-type-options: nosniff
strict-transport-security: max-age=31536000; includeSubDomains; preload

$ curl -s https://next.nourishthenerve.com/health
{"status":"ok","version":"local","timestamp":"2026-08-09T20:10:30.279Z"}

$ curl -sI https://ndnwebstack-sitebucket397a1860-r7jiskyi2d4j.s3.eu-west-2.amazonaws.com/index.html
HTTP/1.1 403 Forbidden
```

`version: "local"` here is expected — this was the manual admin deploy, where `GITHUB_SHA` isn't set. The CI-driven `deploy` job (below) will show the real commit SHA once it runs.

**Regression check — legacy site unaffected:**

```text
$ curl -sI https://nourishthenerve.com/
HTTP/2 302 (redirects to www — unchanged)

$ curl -sI https://www.nourishthenerve.com/
HTTP/2 200 (unchanged)
```

**Local, matching `.github/workflows/ci.yml`'s `quality` job step-for-step** (run under Node 22 — see below):

```bash
pnpm install --frozen-lockfile
pnpm run lint && pnpm run typecheck   # clean
pnpm run test && pnpm run test:integration   # 72 pass
pnpm run test:coverage                 # 100% stmts/lines, 93.75% branches — passes thresholds
pnpm run audit                         # no known vulnerabilities
pnpm run format:check                  # clean
pnpm --filter @ndn/infra run synth     # clean, no AWS credentials needed (cert imported by static ARN)
```

`actionlint .github/workflows/ci.yml` — clean.

### Local environment note: this machine's default Node is unsupported

`docs/plan/00-conventions.md` targets Node 22 (`"engines": {"node": ">=22 <23"}`), but this machine's default `node` was v25.9.0. That's not just a benign version warning: `cdk synth`/`cdk deploy`/`vitest` all bundle the health Lambda via **esbuild**, and under Node 25 esbuild's postinstall staged `bin/esbuild` incorrectly (bundling failed with a `SyntaxError` — pnpm's shim always execs bin scripts via `node <path>`, which broke because `bin/esbuild` is a native Mach-O binary, not a JS launcher). Installing Node 22 (`brew install node@22`, used via `PATH` for this session only — the global default `node` was left untouched) and reinstalling `node_modules` from clean fixed it. CI runs Node 22 natively (`actions/setup-node@v7.0.0` with `node-version: '22'`), so it was never exposed to this.

A second, CI-relevant bug surfaced by the same investigation: `pnpm run test:coverage` (root-level `vitest run --coverage`, exactly what CI's `quality` job runs) failed the same way even under Node 22, because `esbuild` was only a devDependency of `infra/`, not resolvable from the monorepo root — CDK's bundling then fell back to a `pnpm exec` subprocess whose cwd is wherever the process started, and that fallback isn't cwd-portable. **Fix:** `esbuild` added as a root-level devDependency too (`package.json`), so local module resolution succeeds regardless of invocation directory — this was a real gap that would have broken CI's `quality` job, not just a local-machine quirk.

## CI-driven deploy (the DoD's literal requirement)

The manual deploy above proves the stack is correct; **`ci.yml`'s new `deploy` job is what makes this task's DoD ("production deploy succeeded from CI via OIDC") literally true.** It runs once this PR is merged to `main`. [Owner action: watch that first run; fold the result — including the real `DEPLOY_VERSION` shown at `/health` — into this runbook, matching the follow-up-fix pattern already used for TASK 0.2.1/0.3.2 in `ci-pipeline.md`.]

## Cost delta

Per `docs/plan/03-cost-model.md`'s M1 line items now actually incurred: CloudFront ($0, within always-free 1TB+10M req), S3 storage+requests (~$0.10), API Gateway HTTP API (~$0.12), Lambda ($0, within always-free), ACM (free). No new Route 53 zone (existing zone reused, per "Cross-account DNS" above) — only two additional records in it (free; Route 53 charges per query volume, not per record). Net new spend at this traffic level: **≈£0.18/month**, well inside the plan's own +£0.42/mo estimate for this task.

## Not done in this task (explicitly out of scope)

- Apex/`www` DNS — untouched, per the task's explicit prohibition. Cutover is TASK 1.6.1 / Gate G1.
- The real frontend — `infra/assets/site/index.html` is a placeholder; the design system and actual site are TASK 1.1.1 onward.
- `guardrails.ts` wiring to the site bucket — deliberately deferred, see above.
- Canary deploy / auto-rollback / ephemeral per-PR environments — TASK 0.6.x. This is the first deploy job; it has no previous version to roll back to yet.
- Deleting the manually-issued ACM cert or bootstrap stack on any future rollback of *this* stack alone — see Rollback.

## Rollback

- **`WebStack`:** `AWS_PROFILE=ndn-prod npx cdk destroy` (or via CI). The site bucket is `RemovalPolicy.RETAIN`, so it survives stack deletion with only the placeholder page in it — nothing precious is lost, and it can be deleted by hand afterward if truly wanted.
- **DNS:** both manually-added records (`803129122420`, `default` profile) can be removed with `route53 change-resource-record-sets` (`DELETE` action, same record shape as the `UPSERT` above). Apex/`www` are untouched either way.
- **ACM certificate:** harmless to leave (free); delete via `acm delete-certificate` once nothing references it, if desired.
- **CDK bootstrap (`CDKToolkit` stack):** left in place — deleting it would break every future deploy to this account/region, not just this stack's.
