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

## Amendment, 2026-09-02 — published content goes live immediately

*"when I submit a blog post or workshop via principal clinician and then go to the blog and workshop tab it's still empty. I want them to go live immediately."*

ADR-0017 makes the public site statically generated, so both listings were built from a single fetch at `astro build` time and a post published afterwards was simply not in them. The previous amendment made that *visible* (the authoring panel said so, and the deploy job accepts a manual run); this makes it stop happening.

### The listings reconcile, they do not replace

`blog/index.astro` and `workshops/index.astro` still render the build-time list **into the HTML**, and pass it to an island as a seed (`client:load`, not `client:only` — the distinction is the whole point). The island then fetches the live list and replaces the seed.

Three things a plain fetch-on-mount would have thrown away, all of which matter on the one surface that exists to be found:

- **SEO** — a crawler that runs no JavaScript still sees the posts.
- **No flash of empty** — the page paints with content, then reconciles.
- **It survives the API being down** — an unreachable or flag-off content API leaves the build-time list exactly as it was, the same failure mode `content-client.ts` already chose for the build itself.

### Two link shapes, and why that is not a wart

A post that existed at build time has its own prerendered page at `/{locale}/blog/{id}` — a real, canonical, indexed URL. A post published since **cannot**: there is no server to render it and no file on S3 to serve. Those link instead to `/{locale}/blog/post?slug=…`, one prerendered page per locale that resolves any published post client-side (`workshops/workshop?slug=…` is its twin).

It is self-healing: at the next deploy the new post gets its own page, the rebuilt listing links to it normally, and the `?slug=` form stops being used for it. The fallback pages carry `noindex` precisely so the two never compete — two indexable URLs for one article is the trap this shape could otherwise set, and the canonical one should win.

Sending *every* post through the query-string page would have been simpler and was rejected: it trades the site's real article URLs for uniformity.

### What this does not change

Publishing still writes to DynamoDB through the same authoring routes, and the deploy still rebuilds the prerendered pages. The manual `workflow_dispatch` deploy added on 2026-09-01 is now an SEO step rather than a publishing one — worth running so a new article gets its own indexable URL, no longer needed for anyone to *see* it.

### Follow-up, 2026-09-02 — saving now publishes

*"the blog post and workshop when being saved are not being published yet."*

The listing work of 2026-09-01 was correct and was not the problem. Nor was the API: `POST /content` accepts `status` and stores what it is given.

The problem was one unticked checkbox. **"Publish straight away" defaulted to off**, so Save created `status: 'draft'` — and `ContentRepository.list` returns published items only, which is the public read boundary the site has relied on since TASK 1.3.2. So "Save" did exactly what it said and nothing anyone wanted: the post existed, was correct, and no reader could ever reach it. The live listing had nothing to show because there was genuinely nothing published.

Both forms now start with the box **ticked**, and the hint says what that means in both directions. Drafting is still one click away, which is the right way round for a practice that publishes a handful of posts a year: the rare case asks for itself rather than the common one being a trap.

`AuthoringPanel.test.ts` asserts the default and follows it through the request builder to the `status` that actually goes on the wire — the default is the whole bug, and every other link in that chain was already right.

### Follow-up, 2026-09-02 (second) — no web address to type, and drafts you can actually reach

Two things, from *"what is web address text box in new blog post section and why nothing is appearing here /en/blog?"*

**The web-address field is gone.** It was already derived from the title — the box arrived pre-filled and only needed touching in the rare case a title yields no usable slug. But a field you are shown is a field you think you have to understand, and "web address" on a blog form is a question a clinician has no reason to be asked. The slug is derived silently now, and the address is mentioned only in the one case that genuinely needs a person: a title with no letters or digits at all, where the message asks them to reword the title rather than to type a slug.

**Nothing was appearing because nothing was published.** Querying the live public API returned `{"items":[]}` — literally no published content existed. Everything saved before the publish-by-default fix earlier the same day carries `status: 'draft'`, the public read returns published items only (correctly, and by design since TASK 1.3.2), and **nothing in the account area listed anything else**. So work that had been written and saved perfectly well was invisible, with no screen that would ever show it, no way to publish it, and no way even to confirm it existed.

That is the real defect behind the question, and it is bigger than the one that was asked about: the earlier "static site, publish needs a deploy" explanation was true and was never the reason the page was empty.

`AuthoredContentList` now lists everything the practice has written — blog posts and workshops, whatever their status — with a publish/unpublish control on each row. Its data comes from two new `Principal`-only routes, `GET /content/authored` and `GET /workshops/authored`.

**They are separate routes rather than a `status` parameter on the public read**, and that is deliberate: `findPublishedByKeyword` is a boundary, and a flag that could switch a boundary off is the shape a mistake takes. They are gated on `update` rather than `read` for the same kind of reason — `Content item: R` is held by every clinician and by helpdesk, and an unpublished draft is not something the practice has decided to show anyone yet; `update` is `Principal`-only and is exactly what the list exists to enable.

## Images on blog posts and workshops (2026-09-02)

> *"principal clinician should be able to upload media files while creating blog posts and workshops."*

A post or workshop may carry one optional image. Both forms use the same control (`MediaUploadField.tsx`), and both go through the same Lambda (`media-upload.ts`) over two routes.

| | Blog post | Workshop |
| --- | --- | --- |
| Presign route | `POST /content/media-upload-url` | `POST /workshops/media-upload-url` |
| Matrix row | `Content item` | `Workshop` |
| Flag | `content.authoring.enabled` | `workshops.enabled` |
| Key prefix | `media/content/` | `media/workshops/` |
| Record field | `ContentItem.imageKey` | `Workshop.posterKey` |

Accepted: JPEG, PNG, WebP, up to 5 MB. The size limit is browser-side only — a presigned `PutObject` carries no size condition — so it is a courtesy that turns a slow upload into a sentence, not a guarantee.

### The upload happens when the file is chosen, not when the form is submitted

Choosing a file presigns and `PUT`s immediately; the form stores only the returned **key**. So the image is in the bucket before the record that references it is written. Those two can fail independently, and this ordering makes the failure that matters — a published post pointing at an object that was never uploaded — impossible rather than unlikely.

### The `media/` prefix is the public boundary

`web-stack.ts`'s `/media/*` CloudFront behaviour serves the media bucket to anyone, and **it does no path rewriting**: a request for `/media/x/y.jpg` asks S3 for the key `media/x/y.jpg`, verbatim. So the `media/` key prefix *is* the set of publicly readable objects — exactly, and by construction.

That is what keeps assessment attachments out of it. They are in the same bucket under `assessments/`, which is not under `media/`, so no URL that behaviour can serve reaches one.

**Two latent defects were found here, both fixed on 2026-09-02:**

1. **Workshop posters would have 404'd.** The uploader wrote `workshops/<key>`, and `workshopPosterUrl` built `/media/workshops/<key>` — which asks for `media/workshops/<key>`. Never observed, because until #168 no browser could reach the upload endpoint at all, so no poster had ever been uploaded.

2. **The obvious fix was the dangerous one.** Stripping `/media` at the edge would have made the URLs line up — and made `/media/assessments/<key>` serve a clinical recording to anyone who guessed a key. Moving the *keys* under `media/` fixes the same mismatch and makes the private prefix unreachable rather than merely unrouted.

Three things now enforce it, at three layers:

- **IAM** — `MediaUploadPutPublicMedia` grants `s3:PutObject` on `media/*` only, so the presigner cannot mint a URL writing anywhere private.
- **Validation** — `imageKey`/`posterKey` are regex-constrained to keys the presign endpoints issue, so a caller cannot hand back a key they composed.
- **Rendering** — `mediaUrl()` returns `undefined` for anything outside the prefix, so a record written before that validation existed renders no image rather than a link to a private object.

`web-stack.test.ts`'s *"the public media boundary"* block fails if the `/media/*` behaviour ever gains a rewrite function, or if the upload role's grant widens.
