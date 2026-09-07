# Testimonials: moderation queue + consent record (TASK 1.4.2)

**Date:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.4.2](../plan/05-execution-plan.md) · **Requirements:** FR-WEB-06 · **Risks:** R-04 · **Depends on:** 1.3.1, 1.3.2, 1.4.1

**Superseded in part by [TASK 2.5.4](admin-token-retirement.md), 2026-08-22.** The moderation queue's admin-token gate is retired, and the queue moved off `GET /testimonials` onto its own path, `GET /testimonials/pending` — the real Lambda authorizer denies outright on a missing bearer token, so it cannot also gate a path an anonymous visitor must reach, and `GET /testimonials` (published-only) is genuinely, permanently public. See the linked runbook. Submission, consent, and the public listing are unchanged.

## What this covers

Public testimonial submission (Turnstile-verified, rate-limited, reusing TASK 1.4.1's anti-abuse code directly), a moderation queue (publish/reject, never delete — clinician-gated since TASK 2.5.4), and a documented consent record stamped once per testimonial and never mutated afterwards.

## What was built

- **`packages/shared-types/src/testimonial.ts`** — `Testimonial`: `status: 'pending_review' | 'published' | 'rejected'` (never `'deleted'`), `quote: Record<Locale, string>`, `attribution: { display, name? }`, and a `consent` sub-object (`textVersion`, `consentedAt`, `submitterContactHash` — never the raw contact detail).
- **`services/api/src/testimonial-repository.ts`** — `TestimonialStore`/`InMemoryTestimonialStore` + `TestimonialRepository` (`submit`/`publish`/`reject`/`findPublished`/`findPendingReview`). `findPublished`/`findPendingReview` both read every id from one fixed, status-independent GSI2 projection row (written once at creation) and filter by status in application code — a status-*keyed* projection was deliberately avoided: since `DeleteItem` is unavailable to this store, a stale row from a testimonial's *previous* status would never be cleanable, and a published testimonial would keep resurfacing in the pending-review query forever. `InMemoryTestimonialStore.update` throws if a write ever tries to change `consent` from what's already stored — the DoD's "second write to an existing consent object throws," enforced at the store layer since publish/reject only ever echo `consent` back unchanged through the public API surface.
- **`services/api/src/testimonial-submission.ts`** / **`testimonial-submission-handler.ts`** — same gate-in-order shape as `contact-form.ts`/`contact-form-handler.ts` (Turnstile → rate limit → write), reusing `rate-limiter.ts` and the Turnstile secret directly. The HTTP boundary generates the id (`randomUUID`), hashes the submitter's contact email (SHA-256, never stored/logged raw), and requires an attribution name unless `attributionDisplay` is `'anonymous'`.
- **`services/api/src/testimonial-moderation.ts`** / **`testimonial-moderation-handler.ts`** — `GET /testimonials` is the permanently public, unauthenticated, unflagged published-testimonials read. `GET /testimonials/pending` (TASK 2.5.4; originally `?status=pending_review` on the same path as the public read — moved to its own path when the admin-token bridge retired, see [admin-token-retirement.md](admin-token-retirement.md)) is the moderation queue, flag-gated (`testimonials.moderationQueue.enabled`) and clinician-gated. `POST /testimonials/{id}/publish` and `.../reject` are always clinician- and flag-gated, and audited (`audit.ts`) against the real acting clinician.
- **`services/api/src/dynamo-store.ts`** — `DynamoTestimonialStore`: same table as content, a distinct `TESTIMONIAL#<id>` pk prefix and a fixed `TESTIMONIAL_INDEX#all` GSI2 partition key (can't collide with a content keyword's `KEYWORD#...` gsi2pk). `update()` is a `PutCommand` conditioned on `consent = :expectedConsent` — DynamoDB itself rejects any write that would change the stored consent.
- **`infra/src/data-stack.ts`** — `TestimonialSubmissionFunction` (public write path: `ssm:GetParameter` on the Turnstile secret, precise `PutItem`/`TransactWriteItems`, the destructive-action guardrail) and `TestimonialModerationFunction` (`grantReadData` + precise `PutItem`, the guardrail; no admin-secret grant since TASK 2.5.4). `ContentHttpApi` gained `corsPreflight` scoped to the site's own origin — testimonial submission is a live browser fetch straight to this API's own `execute-api.amazonaws.com` origin (no CloudFront proxy exists for it, same as content), unlike the contact form's same-origin `/contact`.
- **`apps/web/src/testimonials/testimonial-client.ts`** — build-time fetch of published testimonials (ADR-0017: no SSR), same never-throws-on-a-cold-API pattern as `blog/content-client.ts`.
- **`apps/web/src/scripts/testimonial-form.ts`** + **`apps/web/src/pages/[locale]/testimonials/index.astro`** — the public page: published testimonials as cards, plus a submission form (quote, attribution choice + optional name, contact email, the same Turnstile widget the contact form uses). The client script posts cross-origin to the data API directly (not same-origin, unlike `contact-form.ts`'s `/contact`) — see the CORS note above.

## Required manual step before this is usable in `ndn-prod`

None beyond what TASK 1.4.1 (Turnstile secret + widget) already required — reused as-is, not re-provisioned. TASK 1.3.2's `ADMIN_API_TOKEN` step this section used to reference no longer applies (TASK 2.5.4).

## What was deliberately not built here

- **No `DELETE /testimonials/:id` endpoint, and no write path that empties a row.** `reject` only ever transitions `status`.
- **No way to edit a testimonial's `consent` once recorded**, at any layer — enforced by the store (in-memory *and* DynamoDB, see above), not just by the API surface omitting an endpoint.
- **No second anti-abuse implementation.** Turnstile verification and `rate-limiter.ts` are TASK 1.4.1's, reused directly.
- **Real-time re-render on submission or moderation.** The public listing is static (`astro build` time); a submission's own page gives immediate inline feedback via the fetch response, but the *listing* only reflects a newly published testimonial on the next deploy — same documented limitation `content-authoring.md` carries for blog posts.

## Cost

£0.00 net-new, per TASK 1.4.2's own line — same table as content, two more Lambdas + a handful of API Gateway routes against infrastructure TASK 1.3.1 already provisioned.

---

## Amendment, 2026-09-02 — patient-authored, published on write, no review

> *"the testimonial page by default should be read only with all published testimonials by various patients. for patients, when logged in, should have option to upload maximum one testimonial with option to update it. otherwise, submit a testimonial shouldn't be available for public and all kinds of clinicians. Also, there is no concept of review a testimonial — it should go live as soon as patient submits it from his account."*

**Everything above about submission and moderation is superseded.** The author is now a signed-in patient, and three pieces of machinery went away with the stranger they existed to guard against.

### What was deleted

| Deleted | Why it existed | Why it does not now |
| --- | --- | --- |
| `testimonial-submission.ts` + handler | anonymous public form | the author has an account |
| Turnstile on this path | proving a human | the authorizer already did |
| `rate-limiter.ts` on this path | flooding | one record per patient — flooding is not a shape the data can take |
| `GET /testimonials/pending` | the moderation queue | there is no review |
| `POST /testimonials/{id}/publish` · `/reject` | approving a stranger's words | published on write |
| `testimonials.submission.enabled` · `testimonials.moderationQueue.enabled` | two halves of one feature | one flag: `testimonials.enabled` |
| the form on `/[locale]/testimonials/` | public submission | the page is read-only |

### What replaced it

- **`authz-matrix.ts`'s `Testimonial (own)` row** — `C R U D` in `Patient (own)`, and **`—` in every other column, the principal's included.** This is the one row where "the principal can do anything" (the 2026-08-31 amendment) is answered *no*. A testimonial is a patient's own words about their care; a practice that can write, edit or approve them is not collecting testimonials.
- **`testimonial-authoring.ts`** — `GET|PUT|DELETE /testimonials/mine`. A singleton path with no id in it, which is the cardinality rule expressed in the URL rather than checked in code.
- **`testimonialIdForPatient()`** — the record id is `sha256(patientId)`. **This is where "maximum one" actually lives:** a second submission addresses the record the first one made, so there is no code path that creates a patient's second testimonial. Hashed because the id lands in a `TESTIMONIAL#<id>` partition key that appears in logs and metrics.
- **`testimonial-read.ts`** — what remains of `testimonial-moderation.ts`: the one route that was always public.

### The public read now projects

`GET /testimonials` used to return `Testimonial` rows whole — on a public, unauthenticated URL. That published `consent.submitterContactHash`, the status, both timestamps and the record id, none of which was ever rendered. Once ids are derived from patient ids, that last one matters.

`toPublicTestimonial()` builds the response by naming what goes in rather than deleting what should not, so a field added to `Testimonial` later is private by default. It also rebuilds `attribution` field by field: an anonymous attribution that still carried a name would otherwise publish it.

### Legacy rows

Anonymous `pending_review` and `rejected` testimonials from the old form still exist. Nothing publishes them — the routes that could are gone — and `findPublished` excludes them, which `testimonial-repository.test.ts` asserts by name. They are stranded rather than deleted (00-conventions.md), and that is the safe direction: they were never approved, and they carry no author who could stand behind them.

**If any pending row should go live, say so** — it is a one-off write, not a feature to rebuild.

### Withdrawal, which was not asked for

`DELETE /testimonials/mine` transitions to `withdrawn` and keeps the text. It is a judgement call, recorded here as one: the request covers writing and updating, not removing. But publication rests on the author's consent, and consent that cannot be withdrawn is not consent — shipping "update only" would leave a patient's public words irrevocable. `'withdraw'` is its own `Action` and its own audit action rather than an `update`, because editing your words is authorship and retracting them is consent.

---

## Amendment, 2026-09-07 — the principal cherry-picks; the patient still owns the words

> *"on webpage the testimonials are shown in some random manner I assume. I want the principal clinician to have option to cherry pick top rated testimonials on the landing page. However, when someone clicks Read more testimonials, there will be more cherry picked shown in chronological order with recent at the top. Principal clinician will have option to cherry pick these testimonials that goes on the websites landing page and those that go inside read more testimonial page."*

### The random order was real

`findPublished` returned testimonials in `listAllIds()` order — the GSI2 projection's order over SHA-256 ids. Stable, arbitrary, and meaningless. It now sorts by `created_at` descending, which is the "chronological order with recent at the top" half of the request and fixes the complaint on its own, curation or not. `created_at`, not `updated_at`: an edit is the same testimonial, and a typo correction should not jump a two-year-old quote to the top.

### Curation is a separate row, a separate record and a separate Lambda

`authz-matrix.ts`'s `Testimonial (own)` row is **unchanged** — every clinician column, the principal's included, is still `—`. The 2026-09-02 reasoning holds exactly as written: a practice that can write, edit or approve a patient's words is not collecting testimonials.

What was added is a new row, `Testimonial placement` (`C R U` for `Principal`, `—` everywhere else), over a new record:

| | |
| --- | --- |
| Record | `TESTIMONIAL_CURATION#site` / `META` — one for the whole site |
| Shape | `{ featured: string[], listed: string[] }` — `featured` is **ordered** (the landing page), `listed` is not (the page is chronological) |
| Routes | `GET` and `PUT /testimonials/curation`, principal-only, flag-gated on the same `testimonials.enabled` |
| Lambda | `TestimonialCurationFunction` — its own role, whose `PutItem` is conditioned on `dynamodb:LeadingKeys = TESTIMONIAL_CURATION#site` |

Three separations, and each is doing work rather than tidying:

- **A separate record** means the principal's write never addresses a patient's row. A `placement` field on the testimonial would also have been lost by a patient editing their quote — `TestimonialStore.update` is a whole-item `PutCommand`.
- **A separate Lambda** means the IAM policy says the same thing the matrix says. `TestimonialAuthoringFunction` may write `TESTIMONIAL#<id>` rows because a patient edits their own testimonial through it; the curation role cannot, so a bug in the curation handler still cannot rewrite anybody's words.
- **A separate row** keeps `can()` honest: the question "may this principal edit a testimonial?" still answers no.

### What the two pages render

Both fetch the same `GET /testimonials` and both mount `LiveTestimonialList`. The payload gained one optional field — `featuredRank`, the quote's position on the landing page — and the homepage passes `featuredOnly`. That is the entire difference between the two surfaces, so they cannot disagree about what a testimonial says.

`curatedTestimonials()` (in `testimonial-read.ts`) applies three rules in order:

1. **Published is still the boundary.** Picks are intersected with `findPublished()`, so a testimonial withdrawn after being picked simply drops out and the principal never has to tidy up after a patient.
2. **No curation record means no curation.** The site behaves exactly as it did before this shipped: every published testimonial, newest first, the newest three ranked for the homepage. This is why deploying it does not empty a live page.
3. **A saved selection governs completely** — including an empty one, which hides every testimonial. A published testimonial in neither list appears nowhere public.

Rule 3 is a change in default and is worth stating to anyone reading this later: **a patient can publish a testimonial that never appears on the site.** They still control publication and withdrawal; the practice controls placement. `accountTestimonial.intro`, `.consentNotice` and `.saved` were reworded the same day so the patient's own screen says so rather than promising a page it no longer guarantees.

### Why the principal's screen sees testimonial ids

The public read still projects `id` away, because it is `sha256(authorPatientId)` on an unauthenticated URL. `GET /testimonials/curation` returns it, because a principal-only screen has to address individual testimonials and the practice already knows who wrote each one (the record carries `authorPatientId`; the author is a patient in its own caseload). `attribution: 'anonymous'` is anonymity from the public reader, never from the clinic. Ids travel in bodies, and `logger.ts` logs route, status and duration — never a body.

### The screen

`/{locale}/account/testimonials`, principal-only, linked from the dashboard's practice-administration list. One radio group per testimonial (landing page + testimonials page / testimonials page only / not shown), then the landing-page picks again in order with move-up/move-down buttons — keyboard-operable, so no drag-and-drop to make accessible. The landing page is capped at `MAX_FEATURED_TESTIMONIALS` (6), enforced in the schema, in `curatedTestimonials`, and as a disabled radio so the limit is visible while choosing rather than announced on save.

### Required manual step before this is usable in `ndn-prod`

None. No new flag (`testimonials.enabled` governs it), no new secret, no console setting — the routes and the Lambda deploy with the stack.

### What was deliberately not built

- **No way for the principal to publish, unpublish, edit or delete a testimonial.** Not an omission — see above.
- **No per-patient invitation or nudge to write one.** Not asked for.
- **No second ordering for the testimonials page.** It is chronological, as specified; storing an order for `listed` would be storing something the read discards.
