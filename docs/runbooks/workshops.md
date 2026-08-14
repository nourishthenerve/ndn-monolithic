# Workshops: model, posters, details, per-language (TASK 1.5.1)

**Date:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.5.1](../plan/05-execution-plan.md) · **Requirements:** FR-WEB-02 · **Decisions:** ADR-0005 · **Depends on:** 1.3.1, 1.3.2, 1.2.1

## What this covers

The first Phase 1 entity with real media: workshop create/edit, publish/cancel (never delete), a presigned poster-upload endpoint into a new media bucket, and the public listing/detail pages. Same admin-token bridge and never-delete discipline TASK 1.3.2/1.4.2 established for content/testimonials, applied to a new entity that also needs S3.

## What was built

- **`packages/shared-types/src/workshop.ts`** — `Workshop`: `status: 'draft' | 'published' | 'cancelled'` (never `'deleted'`), `dateTimeUtc`, `capacity`, `priceMinorUnits` (GBP pence, D-13), `posterKey?`, `details: Record<Locale, { title, description }>`.
- **`services/api/src/workshop-repository.ts`** — `WorkshopStore`/`InMemoryWorkshopStore` + `WorkshopRepository` (`create`/`update`/`publish`/`cancel`/`findById`/`findPublishedUpcoming`). Same fixed, status-independent GSI2 "all workshops" projection row testimonials use, for the same reason: `DeleteItem` is unavailable to this store, so a status- or date-keyed projection could never be cleaned up. `findPublishedUpcoming` filters by `status === 'published' && dateTimeUtc >= now` in application code, both in one pass.
- **`services/api/src/workshop-authoring.ts`** / **`workshop-authoring-handler.ts`** — same shape as `content-authoring.ts`: `POST /workshops`, `PATCH /workshops/{id}`, `POST /workshops/{id}/publish`, `POST /workshops/{id}/cancel`, all admin-token- and flag-gated (`workshops.enabled`), Zod-validated. `priceMinorUnits`/`capacity` rejected if negative or non-integer.
- **`services/api/src/media-upload.ts`** / **`media-upload-handler.ts`** — `POST /workshops/media-upload-url`: admin-token- and flag-gated, issues a short-lived (5 minute) presigned S3 `PutObject` URL for a key under `workshops/`, generated server-side (`workshops/<uuid>-<sanitised-filename>`) so an admin-supplied file name can never inject a path segment. Kept SDK-free (`createPresignedPutUrl` injected) so no test calls real S3; `media-upload-handler.ts` is the only place that calls `@aws-sdk/s3-request-presigner`.
- **`services/api/src/dynamo-store.ts`** — `DynamoWorkshopStore`: same table, a distinct `WORKSHOP#<id>` pk prefix and a fixed `WORKSHOP_INDEX#all` GSI2 partition key (can't collide with content's `KEYWORD#...` or testimonials' `TESTIMONIAL_INDEX#all`). `update()` is a plain `PutCommand`, no consent-style immutability guard (workshops have no equivalent field).
- **`infra/src/web-stack.ts`** — `MediaBucket`: versioned, `BLOCK_ALL` public access, `RemovalPolicy.RETAIN`, same shape as the site bucket. A `/media/*` CloudFront behavior via Origin Access Control (no signed URLs — public marketing collateral once published, per ADR-0005's note on this distinction). `MediaUploadFunction` + its role live here too, **not** in `data-stack.ts` — see the "cross-stack dependency cycle" note below.
- **`infra/src/data-stack.ts`** — `WorkshopReadFunction` (public, `grantReadData` only) and `WorkshopAuthoringFunction` (admin path: `grantReadData` + precise `PutItem`/`TransactWriteItems`, `ssm:GetParameter` on `ADMIN_API_TOKEN`, the destructive-action guardrail). Five new routes on the existing `ContentHttpApi`.
- **`apps/web/src/workshops/workshop-client.ts`** — build-time fetch of published, upcoming workshops (ADR-0017: no SSR), same never-throws-on-a-cold-API pattern as `blog/content-client.ts`/`testimonials/testimonial-client.ts`.
- **`apps/web/src/pages/[locale]/workshops/{index,[slug]}.astro`** — public listing + per-workshop detail pages, mirroring the blog pages' shape (hreflang, hidden-until-populated-locale filtering). Poster images served via `workshopPosterUrl()` (`apps/web/src/site-config.ts`), a relative `/media/<key>` path so it's correct on every domain this site is deployed to without an update at G1 cutover. Date/price are formatted with `Intl.DateTimeFormat`/`Intl.NumberFormat` rather than interpolated as raw strings.

## A cross-stack dependency cycle, and why `MediaUploadFunction` lives in `web-stack.ts`

The first attempt defined `MediaUploadFunction` in `data-stack.ts` (alongside the other workshop Lambdas) with `web-stack.ts`'s `MediaBucket` passed in as a cross-stack prop. That produces a real circular CloudFormation dependency, not just a test artifact: `DataStack` needs the bucket's name/ARN (a cross-stack reference *into* WebStack), while `attachDestructiveActionGuardrail`'s bucket-resource-policy half needs the role's ARN written into the bucket's own policy — which lives in *WebStack*'s template, creating a reference back *into* DataStack. Two opposite-direction stack dependencies cannot both exist; `cdk synth` fails with `DependencyCycle`.

Since `MediaUploadFunction` needs no DynamoDB access at all, the fix was to co-locate it with `MediaBucket` in `web-stack.ts` instead. It's called directly by an admin against that stack's own `HttpApi` endpoint — the same "call the API's own `execute-api.amazonaws.com` URL directly, no CloudFront proxy" pattern `content-authoring.md` already documents for `ContentHttpApi`.

## Required manual step before this is usable in `ndn-prod`

None beyond what TASK 1.3.2 (`ADMIN_API_TOKEN`) already required — reused as-is, not re-provisioned. No new SES/Turnstile/Stripe setup: workshops have no public-facing form in this task (registration/payment is TASK 1.5.2).

## What was deliberately not built here

- **No `DELETE /workshops/:id` endpoint, and no write path that empties a row.** `cancel` only ever transitions `status`; a cancelled workshop's row and poster stay retrievable.
- **No `s3:DeleteObject` grant anywhere.** `MediaUploadFunctionRole` gets `s3:PutObject` scoped to the `workshops/` prefix only; the guardrail denies `DeleteObject`/`DeleteObjectVersion` bucket-wide regardless.
- **No registration/capacity-reservation/payment.** `capacity`/`priceMinorUnits` are stored and displayed, but nothing yet reserves a place or takes payment — that's TASK 1.5.2 (Stripe Checkout), which depends on this task.
- **Real-time re-render on publish/cancel.** Same documented limitation `content-authoring.md`/`testimonials.md` carry: the public pages are static (`astro build` time), so a newly published or cancelled workshop only reflects on the next deploy.

## Cost

£0.00 net-new DynamoDB/Lambda line (same table, a handful more routes, per TASK 1.5.1's own cost note) plus a second S3 bucket + CloudFront behavior, both within `03-cost-model.md`'s existing M1 S3/CloudFront lines — re-verify at the next gate if poster files turn out large.
