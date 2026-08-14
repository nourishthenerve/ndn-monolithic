# Testimonials: moderation queue + consent record (TASK 1.4.2)

**Date:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.4.2](../plan/05-execution-plan.md) · **Requirements:** FR-WEB-06 · **Risks:** R-04 · **Depends on:** 1.3.1, 1.3.2, 1.4.1

## What this covers

Public testimonial submission (Turnstile-verified, rate-limited, reusing TASK 1.4.1's anti-abuse code directly), an admin-token-gated moderation queue (publish/reject, never delete), and a documented consent record stamped once per testimonial and never mutated afterwards.

## What was built

- **`packages/shared-types/src/testimonial.ts`** — `Testimonial`: `status: 'pending_review' | 'published' | 'rejected'` (never `'deleted'`), `quote: Record<Locale, string>`, `attribution: { display, name? }`, and a `consent` sub-object (`textVersion`, `consentedAt`, `submitterContactHash` — never the raw contact detail).
- **`services/api/src/testimonial-repository.ts`** — `TestimonialStore`/`InMemoryTestimonialStore` + `TestimonialRepository` (`submit`/`publish`/`reject`/`findPublished`/`findPendingReview`). `findPublished`/`findPendingReview` both read every id from one fixed, status-independent GSI2 projection row (written once at creation) and filter by status in application code — a status-*keyed* projection was deliberately avoided: since `DeleteItem` is unavailable to this store, a stale row from a testimonial's *previous* status would never be cleanable, and a published testimonial would keep resurfacing in the pending-review query forever. `InMemoryTestimonialStore.update` throws if a write ever tries to change `consent` from what's already stored — the DoD's "second write to an existing consent object throws," enforced at the store layer since publish/reject only ever echo `consent` back unchanged through the public API surface.
- **`services/api/src/testimonial-submission.ts`** / **`testimonial-submission-handler.ts`** — same gate-in-order shape as `contact-form.ts`/`contact-form-handler.ts` (Turnstile → rate limit → write), reusing `rate-limiter.ts` and the Turnstile secret directly. The HTTP boundary generates the id (`randomUUID`), hashes the submitter's contact email (SHA-256, never stored/logged raw), and requires an attribution name unless `attributionDisplay` is `'anonymous'`.
- **`services/api/src/testimonial-moderation.ts`** / **`testimonial-moderation-handler.ts`** — `GET /testimonials` is one handler serving two audiences on one path (HttpApi can only route a path to one Lambda integration): no `status` query param (or anything but `pending_review`) returns published testimonials, unauthenticated, no flag gate; `?status=pending_review` is admin-token-gated (reusing `admin-auth.ts`'s bridge, TASK 1.3.2) and flag-gated (`testimonials.moderationQueue.enabled`). `POST /testimonials/{id}/publish` and `.../reject` are always admin-token- and flag-gated, and audited (`audit.ts`).
- **`services/api/src/dynamo-store.ts`** — `DynamoTestimonialStore`: same table as content, a distinct `TESTIMONIAL#<id>` pk prefix and a fixed `TESTIMONIAL_INDEX#all` GSI2 partition key (can't collide with a content keyword's `KEYWORD#...` gsi2pk). `update()` is a `PutCommand` conditioned on `consent = :expectedConsent` — DynamoDB itself rejects any write that would change the stored consent.
- **`infra/src/data-stack.ts`** — `TestimonialSubmissionFunction` (public write path: `ssm:GetParameter` on the Turnstile secret, precise `PutItem`/`TransactWriteItems`, the destructive-action guardrail) and `TestimonialModerationFunction` (admin path: `ssm:GetParameter` on `ADMIN_API_TOKEN`, `grantReadData` + precise `PutItem`, the guardrail). `ContentHttpApi` gained `corsPreflight` scoped to the site's own origin — testimonial submission is a live browser fetch straight to this API's own `execute-api.amazonaws.com` origin (no CloudFront proxy exists for it, same as content), unlike the contact form's same-origin `/contact`.
- **`apps/web/src/testimonials/testimonial-client.ts`** — build-time fetch of published testimonials (ADR-0017: no SSR), same never-throws-on-a-cold-API pattern as `blog/content-client.ts`.
- **`apps/web/src/scripts/testimonial-form.ts`** + **`apps/web/src/pages/[locale]/testimonials/index.astro`** — the public page: published testimonials as cards, plus a submission form (quote, attribution choice + optional name, contact email, the same Turnstile widget the contact form uses). The client script posts cross-origin to the data API directly (not same-origin, unlike `contact-form.ts`'s `/contact`) — see the CORS note above.

## Required manual step before this is usable in `ndn-prod`

None beyond what TASK 1.3.2 (`ADMIN_API_TOKEN`) and TASK 1.4.1 (Turnstile secret + widget) already required — both are reused as-is, not re-provisioned.

## What was deliberately not built here

- **No `DELETE /testimonials/:id` endpoint, and no write path that empties a row.** `reject` only ever transitions `status`.
- **No way to edit a testimonial's `consent` once recorded**, at any layer — enforced by the store (in-memory *and* DynamoDB, see above), not just by the API surface omitting an endpoint.
- **No second anti-abuse implementation.** Turnstile verification and `rate-limiter.ts` are TASK 1.4.1's, reused directly.
- **Real-time re-render on submission or moderation.** The public listing is static (`astro build` time); a submission's own page gives immediate inline feedback via the fetch response, but the *listing* only reflects a newly published testimonial on the next deploy — same documented limitation `content-authoring.md` carries for blog posts.

## Cost

£0.00 net-new, per TASK 1.4.2's own line — same table as content, two more Lambdas + a handful of API Gateway routes against infrastructure TASK 1.3.1 already provisioned.
