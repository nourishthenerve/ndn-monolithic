# Blog authoring, publish/unpublish, SEO (TASK 1.3.2)

**Date:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.3.2](../plan/05-execution-plan.md) · **Requirements:** FR-WEB-01 · **Depends on:** 1.3.1, 0.3.3, 0.6.1

**Superseded in part by [TASK 2.5.4](admin-token-retirement.md), 2026-08-22.** The bearer-token gate this runbook originally documented is retired — authoring now authenticates with the real Lambda authorizer and `can()` against a real clinician `Principal`, per the linked runbook. Everything below about the *content* mechanics (repository, publish/unpublish, static blog pages, SEO) is unchanged and still accurate; everything about the token — its SSM parameter, the manual creation step, the "no user identity" limitation — is historical and kept for context, not as the current procedure.

## What this covers

The write side of TASK 1.3.1's content entity: create/edit a blog post, publish it, unpublish it (never delete it), plus the public blog pages and their SEO/hreflang. Originally gated by one narrow, explicitly-temporary bearer token because Phase 2 (Cognito/RBAC) didn't exist yet (`09-self-audit.md` flagged this ordering tension) — TASK 2.5.4 is Phase 2 following through on that plan.

## What was built

- **`services/api/src/content-repository.ts`** — `ContentStore.update()` (Put-based overwrite, additive-only keyword re-projection — see its own comment for why a dropped keyword's GSI2 row can never be removed) and `ContentRepository.update/publish/unpublish`. Every created/updated item is also implicitly tagged with its own `contentType` as a keyword, so `GET /content?keyword=blog` lists every blog post without a new index or a table Scan.
- **`services/api/src/content-authoring.ts`** — `createContentAuthoringHandler`: routes `POST /content`, `PATCH /content/{id}`, `POST /content/{id}/publish`, `POST /content/{id}/unpublish` by `event.routeKey`. Flag-gated (404 off), Zod-validated bodies (400), `AppError` → 404/409. Authentication and authorisation are TASK 2.5.4's own — see [admin-token-retirement.md](admin-token-retirement.md).
- **`services/api/src/content-authoring-handler.ts`** — the deployed Lambda entry, wiring the real DynamoDB-backed repository together.
- **`infra/src/data-stack.ts`** — `ContentAuthoringFunction` + its own least-privilege role (`grantReadData` + explicit `PutItem`/`TransactWriteItems`, **not** `grantWriteData`'s blanket grant, which includes `DeleteItem`), `attachDestructiveActionGuardrail` (defence in depth even though the identity policy alone doesn't grant delete). New routes on the existing `ContentHttpApi`.
- **`apps/web/src/blog/*`, `apps/web/src/pages/[locale]/blog/*`** — public blog index + post pages, built statically (ADR-0017: zero SSR) from `GET /content?keyword=blog` at `astro build` time. Per-post `<title>`/`<meta description>`/`<link canonical>`/hreflang.
- **`apps/web/src/pages/404.astro`** + a CloudFront `errorResponses` mapping in `web-stack.ts` — closes a pre-existing gap (no 404 page existed at all; a missing S3 key returned CloudFront/S3's raw 403 XML) that TASK 1.3.2's own "not a raw 404" requirement can't be met without.

## Required manual step before this is usable in `ndn-prod`

None any more. The `ADMIN_API_TOKEN` SSM parameter this section used to document creating no longer has any reader — see [admin-token-retirement.md](admin-token-retirement.md) for the parameter's own retirement (deleted by hand, once, after TASK 2.5.4's deploy is verified). Authoring today needs a clinician account (TASK 2.4.1) to sign in with, nothing created out-of-band.

## What was deliberately not built here

- **No `DELETE /content/:id` endpoint, and no `UpdateItem` that empties a row** — `unpublish` only ever transitions `status`.
- **No CloudFront proxy from the public domain to `ContentHttpApi`.** The Astro build fetches the content API's own `execute-api.amazonaws.com` URL directly at build time — same-origin proxying (mentioned as future work in `data-stack.ts`'s TASK 1.3.1 comment) stays deferred, since nothing in this task needs a runtime (browser-side) call to the API: SEO requires the content baked into the static HTML at build time regardless.
- **Real-time unpublish.** Because the blog pages are static and built at deploy time, unpublishing a post takes effect on the *next* deploy, not instantly. `content.readApi`/`content.authoring` are both API-level changes that take effect immediately; only the pre-rendered HTML lags until a rebuild. Documented, not solved — solving it for real needs either SSR (ADR-0017 rules out by design) or a client-side runtime re-check script, which was judged not worth the added JS for a Phase-1 clinic blog.

## Cost

£0.00 net-new, per TASK 1.3.2's own line — one more Lambda + a handful of API Gateway routes against infrastructure TASK 1.3.1 already provisioned; SSM Standard parameters are free.
