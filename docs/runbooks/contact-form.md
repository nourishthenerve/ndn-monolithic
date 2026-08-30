# Contact form: SES relay, Turnstile, rate limiting (TASK 1.4.1)

**Date:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.4.1](../plan/05-execution-plan.md) · **Requirements:** FR-WEB-04, C-11 · **Decisions:** ADR-0009, **superseded by D-32** · **Depends on:** 1.2.1, 1.1.2, 0.6.1

## Deleted, D-32 (2026-08-30) — WhatsApp replaces the form

**The entire flow this runbook describes is deleted, not merely disabled.** The owner's own words: "remove this form, the patient/visit will contact to the whatsapp business account." `contact-form.ts`, `contact-form-handler.ts`, `ses.ts`'s `createSesContactEmailSender`, `apps/web/src/scripts/contact-form.ts`, the `contact.form.enabled` flag, `ContactFormFunction`/its role/its `/contact` route and CloudFront behavior — all gone from the codebase, along with every test that covered them. `POST /contact` no longer exists at any status code. `apps/web/src/pages/[locale]/contact.astro` is now a static link to the clinic's WhatsApp Business number (`apps/web/src/site-config.ts`'s `whatsappBusinessNumber`/`whatsappChatUrl`) — the identical human-staffed channel D-29 already established for patient account creation ([patient-account-provisioning.md](patient-account-provisioning.md)). Turnstile (`turnstile.ts`) and `rate-limiter.ts` are **not** deleted — testimonial submission (TASK 1.4.2) is their other, still-live caller.

**What survives unchanged:** nothing operational — this was a single-purpose relay with no shared state for anything downstream to depend on, unlike `patient-registration.md`'s approval lifecycle. This file is kept as a historical record of what TASK 1.4.1 built and why, per this codebase's own "amend, don't delete" convention for runbooks. Everything from "What this covers" onward describes the retired mechanism and should be read as history, not current behaviour.

## What this covers (as originally built — see the note above for its current status)

The first working contact form this platform has ever had — the legacy site's own `POST /form` 404s (`legacy-estate.md`). A visitor's message is Turnstile-verified, rate-limited (3/hour per hashed source IP), then relayed by SES to the clinic's existing Zoho inbox, with `ReplyTo` set to the visitor's own address so a normal "Reply" reaches them directly.

## What was built

- **`services/api/src/rate-limiter.ts`** — the fixed-window `RateLimiter`/`InMemoryRateLimiter` extracted out of `sms-rate-limiter.ts` (TASK 0.5.3); it was already principal-generic. `sms-rate-limiter.ts` now re-exports it unchanged — its own tests pass with no modification.
- **`services/api/src/turnstile.ts`** — `createTurnstileVerifier`: POSTs to Cloudflare's `siteverify` endpoint behind an injected `Fetcher` (same seam as `smoke-test.ts`'s own outbound call), so no test reaches Cloudflare for real. Never throws — a network error, non-2xx, or unparseable body are all treated as rejection.
- **`services/api/src/ses.ts`** — `createSesContactEmailSender`: one `SendEmailCommand` per submission, `From` the verified `nourishthenerve.com` domain identity, `To: contact@nourishthenerve.com`, `ReplyTo` the submitter's address.
- **`services/api/src/contact-form.ts`** — `createContactFormHandler`: the gate-in-order business logic (Turnstile → rate limit → send), deliberately SDK-free and HTTP-free — same shape as `sms.ts`'s `createSmsSender`, not `content-authoring.ts`'s HTTP-shaped handler, so it stays reusable by a channel other than API Gateway if one ever needs it.
- **`services/api/src/contact-form-handler.ts`** — the HTTP boundary: `createContactFormHttpHandler` (flag gate, Zod body validation *before* Turnstile is ever checked, source-IP hashing) is itself dependency-injected and unit-tested; the file's tail is the once-per-cold-start AWS wiring (SSM-resolved Turnstile secret, real SES client, real `fetch`) that only this file touches.
- **`infra/src/web-stack.ts`** — `ContactFormFunction` + its own least-privilege role (`ssm:GetParameter` scoped to the one Turnstile parameter ARN; `ses:SendEmail` scoped to the one verified identity ARN — no DynamoDB/S3 access at all, so the destructive-action guardrail doesn't apply here). New `POST /contact` route on the existing `HttpApi`, proxied same-origin through CloudFront (`/contact` behavior, same shape as `/health`) — no CORS needed since the browser only ever calls its own domain. CSP's `script-src`/`frame-src` extended for `https://challenges.cloudflare.com` only.
- **`apps/web/src/pages/[locale]/contact.astro`** + **`apps/web/src/scripts/contact-form.ts`** — a static page (ADR-0017: no SSR) whose only interactivity is a plain, externally-bundled module script (not a `client:*` island — same CSP reasoning `CookieBanner.tsx` documents). All user-facing status copy is read from `data-*` attributes set via `t()`, never hardcoded in the script.

## Required manual steps before this is usable for real in `ndn-prod`

**[Owner action] 1. Create the Turnstile secret SSM parameter**, out-of-band — same convention every SSM SecureString in this repo follows (`infra/src/config.ts`'s `CERTIFICATE_ARN`, and previously `content-authoring.md`'s now-retired `ADMIN_API_TOKEN`, TASK 2.5.4):

```sh
aws ssm put-parameter \
  --name /ndn/turnstile-secret-key \
  --type SecureString \
  --value "<the real Turnstile secret key>" \
  --profile ndn-prod --region eu-west-2
```

**[Owner action] 2. Create a real Turnstile widget** in the Cloudflare dashboard for `next.nourishthenerve.com` (and later the apex, at G1). Cloudflare issues a site key (public) and a secret key (goes into step 1). Until this is done, `apps/web/src/site-config.ts`'s `turnstileSiteKey` is Cloudflare's own publicly documented "always passes" **test** key (`1x00000000000000000000AA`) — safe to ship (not secret), but it does not provide real spam protection. Replace it with the real site key once the widget exists, and redeploy.

**3. Confirm SES production access.** LL-01 was actioned in `docs/runbooks/ses-production-access.md` (production-access request submitted, `PENDING` at time of writing). Check `aws sesv2 get-account --profile ndn-prod --region eu-west-2` — until `ProductionAccessEnabled: true`, SES can only deliver to addresses individually verified in the sandbox, so a real end-to-end send to `contact@nourishthenerve.com` needs that address verified first (`aws sesv2 create-email-identity --email-identity contact@nourishthenerve.com` as a fallback, or wait for production access).

**4. Flip the flag.** `contact.form.enabled` defaults off (SSM-backed `FlagSource` doesn't exist yet — same documented gap `content-authoring-handler.ts` carries; an `InMemoryFlagSource` that nothing ever sets keeps it off in production). Enable it only after a deliberately-invalid Turnstile token is confirmed rejected on the ephemeral PR env, and a real submission is confirmed to arrive at `contact@nourishthenerve.com`.

## What was deliberately not built here

- **No persistent, cross-invocation rate-limit store.** `ContactFormFunction`'s `InMemoryRateLimiter` resets on cold start — the same accepted limitation `sms-rate-limiter.ts` carries until a real provider needs one (M2.2). Low-volume contact-form traffic doesn't justify a DynamoDB-backed counter yet.
- **No CORS configuration.** The browser only ever calls `/contact` on its own origin (CloudFront proxies it same-origin, ADR 0003/D-08) — a cross-origin call was never a requirement.
- **No logging of the submitter's raw IP or message body.** The rate limiter's `principal` is a SHA-256 hash of the source IP, computed once in `contact-form-handler.ts` and never passed further; `contact-form.ts` never receives the raw address at all. The sampled request logger only ever records route/status/duration/requestId, the same shape every other handler in this repo uses.
- **No second anti-abuse implementation for testimonials.** TASK 1.4.2 reuses this task's Turnstile verifier and `rate-limiter.ts` directly.

## Cost

£0.00 net-new, per TASK 1.4.1's own line — SES send volume already appears in `03-cost-model.md`'s M1 line (~$0.05); Turnstile is free tier; one more Lambda + two API Gateway routes + one CloudFront behavior against infrastructure `0.4.1` already provisioned.
