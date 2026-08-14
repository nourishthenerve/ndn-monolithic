# Blog authoring, publish/unpublish, SEO (TASK 1.3.2)

**Date:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.3.2](../plan/05-execution-plan.md) · **Requirements:** FR-WEB-01 · **Depends on:** 1.3.1, 0.3.3, 0.6.1

## What this covers

The write side of TASK 1.3.1's content entity: create/edit a blog post, publish it, unpublish it (never delete it), plus the public blog pages and their SEO/hreflang. Phase 2 (Cognito/RBAC) doesn't exist yet (`09-self-audit.md` flags this ordering tension), so authoring is gated by one narrow, explicitly-temporary bearer token rather than waiting on Phase 2.

## What was built

- **`services/api/src/admin-auth.ts`** — `verifyAdminToken(header, expectedToken)`: extracts a `Bearer` token and compares it in constant time (`node:crypto.timingSafeEqual`). Pure, SDK-free.
- **`services/api/src/content-repository.ts`** — `ContentStore.update()` (Put-based overwrite, additive-only keyword re-projection — see its own comment for why a dropped keyword's GSI2 row can never be removed) and `ContentRepository.update/publish/unpublish`. Every created/updated item is also implicitly tagged with its own `contentType` as a keyword, so `GET /content?keyword=blog` lists every blog post without a new index or a table Scan.
- **`services/api/src/content-authoring.ts`** — `createContentAuthoringHandler`: routes `POST /content`, `PATCH /content/{id}`, `POST /content/{id}/publish`, `POST /content/{id}/unpublish` by `event.routeKey`. Flag-gated (404 off), token-gated (401), Zod-validated bodies (400), `AppError` → 404/409.
- **`services/api/src/content-authoring-handler.ts`** — the deployed Lambda entry: resolves `ADMIN_API_TOKEN` from SSM (SecureString, D-14), cached per cold start.
- **`infra/src/data-stack.ts`** — `ContentAuthoringFunction` + its own least-privilege role (`grantReadData` + explicit `PutItem`/`TransactWriteItems`, **not** `grantWriteData`'s blanket grant, which includes `DeleteItem`), `attachDestructiveActionGuardrail` (defence in depth even though the identity policy alone doesn't grant delete), and `ssm:GetParameter` scoped to the one parameter ARN. New routes on the existing `ContentHttpApi`.
- **`apps/web/src/blog/*`, `apps/web/src/pages/[locale]/blog/*`** — public blog index + post pages, built statically (ADR-0017: zero SSR) from `GET /content?keyword=blog` at `astro build` time. Per-post `<title>`/`<meta description>`/`<link canonical>`/hreflang.
- **`apps/web/src/pages/404.astro`** + a CloudFront `errorResponses` mapping in `web-stack.ts` — closes a pre-existing gap (no 404 page existed at all; a missing S3 key returned CloudFront/S3's raw 403 XML) that TASK 1.3.2's own "not a raw 404" requirement can't be met without.

## Required manual step before this is usable in `ndn-prod`

**[Owner action]** The `ADMIN_API_TOKEN` SSM parameter is created out-of-band, not by CDK — same reasoning `infra/src/config.ts`'s `CERTIFICATE_ARN` documents for the ACM certificate: committing a secret value into CDK/CloudFormation state is exactly what SecureString exists to avoid. Run once, from the `ndn-prod` profile, after this PR merges (`ContentAuthoringFunction`'s role grant needs the parameter to already exist at first deploy, or the very first authoring request 500s until it does):

```sh
aws ssm put-parameter \
  --name /ndn/admin-api-token \
  --type SecureString \
  --value "$(openssl rand -base64 32)" \
  --profile ndn-prod --region eu-west-2
```

Save the generated value somewhere durable (a password manager) — it's the only credential that can call the authoring endpoints until Phase 2's Cognito RBAC replaces this bridge. Rotating it is the same command with `--overwrite`; the Lambda picks up the new value on its next cold start (no live-rotation — see `content-authoring-handler.ts`'s own comment).

## What was deliberately not built here

- **No `DELETE /content/:id` endpoint, and no `UpdateItem` that empties a row** — `unpublish` only ever transitions `status`.
- **No user identity.** The bearer token proves "an authorised editor," not *which* one — the audit trail (`audit.ts`) records every mutation against one shared `actor` (`'admin-token'`) until Phase 2.
- **No CloudFront proxy from the public domain to `ContentHttpApi`.** The Astro build fetches the content API's own `execute-api.amazonaws.com` URL directly at build time — same-origin proxying (mentioned as future work in `data-stack.ts`'s TASK 1.3.1 comment) stays deferred, since nothing in this task needs a runtime (browser-side) call to the API: SEO requires the content baked into the static HTML at build time regardless.
- **Real-time unpublish.** Because the blog pages are static and built at deploy time, unpublishing a post takes effect on the *next* deploy, not instantly. `content.readApi`/`content.authoring` are both API-level changes that take effect immediately; only the pre-rendered HTML lags until a rebuild. Documented, not solved — solving it for real needs either SSR (ADR-0017 rules out by design) or a client-side runtime re-check script, which was judged not worth the added JS for a Phase-1 clinic blog.

## Cost

£0.00 net-new, per TASK 1.3.2's own line — one more Lambda + a handful of API Gateway routes against infrastructure TASK 1.3.1 already provisioned; SSM Standard parameters are free.
