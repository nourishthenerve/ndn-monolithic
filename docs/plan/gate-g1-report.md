# Gate G1 report — Phase 1 (public website)

**Date:** 2026-08-21 · **Scope:** TASK 1.1.1 through 1.6.1 · **Checklist:** [06-gate-checklists.md](06-gate-checklists.md) · **Previous gate:** [gate-g0-report.md](gate-g0-report.md)

## Go/no-go

**NO-GO on declaring Gate G1 met. CONDITIONAL GO on starting Phase 2**, on the owner's standing decision to park the apex cutover while AWS works the support case.

G1's three gate-specific criteria are "apex serving new site, legacy retired, Core Web Vitals pass". Two are met — legacy retired comprehensively (§2), and Core Web Vitals now measured and passing on every route with a great deal of headroom (§7, actioned during this review). One is blocked outside this project's control: the apex, on an AWS support case with no reply.

That much was expected. What this review found that was **not** expected is more consequential than the cutover:

**Every user-facing feature Phase 1 built is switched off in production, and no mechanism exists to switch any of them on.** Nine Lambda handlers each construct a `CachedFlagReader` over an `InMemoryFlagSource` that nothing ever writes to, so every flag reads `false` forever. Verified live, not inferred: `GET /content`, `GET /workshops` and `POST /contact` all return `404 NOT_FOUND` — the documented flag-off response. There are no SSM parameters in the account outside CDK's own bootstrap. The blog, blog authoring, contact form, testimonials (submission and moderation), workshops, media upload and Stripe checkout are all unreachable, and turning any of them on requires a code change and a deploy — which is precisely what TASK 0.6.1 and D-23 exist to avoid ("letting an operator flip a flag without a deploy").

The site at `next.nourishthenerve.com` is therefore a static brochure: correct, accessible-ish, well-built, and inert. Calling Phase 1 "complete" on the strength of merged code and green unit tests would be wrong, and the gate is the place to say so.

Second, **the accessibility gate that G1 exists to enforce has not run on a single Phase 1 pull request.** The `pr-environment` CI job was disabled on 2026-08-13 (`&& false`, owner decision, cost of CI minutes) and it is the only place `a11y-full.test.ts` and `keyboard.test.ts` execute. Everything from TASK 1.2.1 onward merged without it. Run by hand against the live site for this review, it fails on 4 of 15 routes, and at least one failure is a genuine keyboard-accessibility defect that axe cannot see (§7).

Nothing found here endangers data or costs money. But Phase 2 builds authentication and RBAC on top of this foundation, and two of these — the flag source and the a11y gate — are foundation, not polish. They should be fixed before Phase 2 work lands, not after.

**Actioned since the findings above were written**, on the owner's go-ahead and each on its own branch: the flag source is fixed (§3a), Core Web Vitals is measured and passing (§7), and — as of 2026-08-21 — the a11y gate is fixed, re-enabled and now blocking (§7, action items 2 and 3). The gate verdict is unchanged: G1 cannot be declared met while the apex criterion is blocked. Of the four engineering action items this review raised, three are closed; the log-retention leak (§4) is the one still open.

## 1. Full test suite

`pnpm -r lint && pnpm -r typecheck && pnpm test` run fresh against `main` (`d64a5b1`) on 2026-08-21:

- **Lint:** clean across all 12 workspace packages, including `check-no-disable-comments.mjs`.
- **Typecheck:** clean across all 12 workspace packages.
- **Tests:** **559 tests / 80 files, 0 failures.** Per package: `services/api` 300, `infra` 98, `packages/ui` 74 (+5 Playwright reduced-motion), `apps/web` 52, `packages/i18n` 14, `packages/eslint-plugin-no-destructive` 12, `packages/shared-types` 3, `packages/eslint-plugin-i18n` 2, `apps/mobile` 1, `packages/api-client` 1, `services/workers` 1, `tests` 1.
- **`pnpm lint:no-destructive`:** 12 fixture violations caught, exits non-zero, as designed.
- **`pnpm audit --audit-level=high`:** no known vulnerabilities.
- **CI on `main`:** the last three runs are green (`31885381778`, `31883355180`, `31879865251`). The one red run in the window, `31845241373`, is the PR #38 merge whose `deploy` job hit the CloudFront alias conflict — fully analysed in [g1-cutover.md](../runbooks/g1-cutover.md), rolled back cleanly, no production impact.

**Skips to explain — one, and it matters:** the `pr-environment` job (and with it the entire real-browser a11y + keyboard suite from TASK 1.1.3) had been disabled since 2026-08-13. It is not a skip inside a test run; it is a whole CI job short-circuited by `&& false`. See §7. **Re-enabled 2026-08-21** and now in the required gate — this was the state at the time of the review, not the state today.

## 1a. Regression diff against the previous gate

| Measure | G0 (2026-08-13) | G1 (2026-08-21) | Δ |
|---|---|---|---|
| Tests / files | 145 / 32 | 559 / 80 | +414 / +48 |
| Workspace packages | 12 | 12 | — |
| CloudFormation stacks | 3 | 4 (`NdnDataStack` added) | +1 |
| Lambda functions | 3 | 13 | +10 |
| DynamoDB tables | 0 | 1 | +1 |
| Live public routes | 1 placeholder | 15 (`routes.ts`) | +14 |
| Orphaned log groups, no retention | 2 | 10 | **+8** |
| `ndn-prod` month-to-date spend | $0.025 | $0.096 | +$0.071 |

No test regressed. No previously-passing check now fails. The one metric moving the wrong way is orphaned log groups — G0's §4 finding, unactioned, now five times larger (§4).

## 2. Requirement traceability

| Task | DoD | Status | Note |
|---|---|---|---|
| 1.1.1 Design system + tokens, WCAG primitives | Tokens + primitives, reduced-motion | **COMPLETE** | 74 unit + 5 Playwright reduced-motion tests. Primitives are native semantic HTML as the DoD required — confirmed in the live DOM. |
| 1.1.2 i18n framework | No string bypasses `t()`, `/en/` routing | **COMPLETE** | `/en/...` routing live. English-only catalogue is correct, not a gap — `Locale` is `'en'`, `rtlLocales` deliberately empty per D-04/LL-08. `/ar` returning 404 is by design. Lint rule `ndn/no-hardcoded-strings` runs in the required gate. |
| 1.1.3 CI accessibility checks | Every route axe-checked **on every PR** | **GAP (material)** → **CLOSED 2026-08-21** | The suite exists and is good. It had not run on any PR since 2026-08-13 — see §7. Run manually for this gate: axe clean on all 15 routes, keyboard suite **failed on 4**. Since fixed (§7's corrections), and `pr-environment` is re-enabled *and* in `ci-summary`'s required-gate loop, so the DoD's "on every PR" is now literally true and blocking. |
| 1.2.1 Public pages, nav, footer | Pages + nav + configurable social links | **COMPLETE** | All 15 routes `200`. Nav/footer present and keyboard-reachable. |
| 1.2.2 Legal pages | Five legal pages as i18n placeholders | **COMPLETE** | privacy, cookies, terms, accessibility-statement, clinical-disclaimer all `200`, all axe-clean. |
| 1.2.3 Cookie consent, self-hosted fonts | Consent gate; no `http://` font dependency | **COMPLETE** | Verified live: no font request leaves the origin; banner is keyboard-operable; a recorded decision survives reload. |
| 1.3.1 Blog model, content, keyword tagging | Model + read API | **BUILT, DARK** | `GET /content` → `404 NOT_FOUND` (flag off, unsettable). See §3a. |
| 1.3.2 Blog authoring, publish/unpublish, SEO | Authoring + hreflang | **BUILT, DARK** | Same. `siteUrl` still `https://next.nourishthenerve.com` — correct while `next.` is the live origin; flip at cutover, per [g1-cutover.md](../runbooks/g1-cutover.md) step 5. |
| 1.4.1 Contact form → SES, Turnstile, rate limit | Form relays; spam-protected | **BUILT, DARK** + 2 open owner actions | `POST /contact` → `404`. Turnstile still uses Cloudflare's public "always passes" test key (disclosed owner action in [contact-form.md](../runbooks/contact-form.md)). SES production access **DENIED** — §6. |
| 1.4.2 Testimonials + moderation + consent | Queue + consent record | **BUILT, DARK** | Submission and moderation both flag-gated off. Consent copy is present and correct on the live form. |
| 1.5.1 Workshops: model, posters, details | Model + per-language details | **BUILT, DARK** | `GET /workshops` → `404`. |
| 1.5.2 Stripe Checkout + webhooks + confirmation email | Idempotent webhooks; confirmation email | **BUILT, DARK** | Flag off *and* gated on LL-03. Confirmation email would additionally fail today — SES sandbox cannot send to an arbitrary registrant (§6). `SITE_ORIGIN` fallback still points at `next.`, unwired as a CDK env var — same cutover-time change as `siteUrl`. |
| 1.6.1 G1 cutover | Apex serves new site; legacy Lambda gone | **PARTIAL — one half done, one half blocked** | **Legacy retired: yes, completely** — Lambda, Function URL, log group, 5 IAM roles, 6 policies all deleted 2026-08-15; `get-function` → `ResourceNotFoundException`; R-06 closed by removal, not containment. **Apex: blocked** on a CloudFront alias held by a third account (ends `155257`); AWS support case filed, awaiting reply. Re-verified unchanged 2026-08-21. |

**Coverage summary:** FR-X-01 (i18n), FR-X-02 (a11y), and the Phase 1 public-site FRs all map to merged, tested code. What they do **not** yet map to is reachable production behaviour — see §3a. C-01 (cost) and the §6.7 destructive prohibitions remain fully satisfied.

## 3. Authorisation-boundary re-audit (from scratch, live)

- **`357601815388` (`ndn-prod`):** four roles, unchanged and matching their runbooks — `ndn-deploy` (OIDC, `main`-only), `ndn-deploy-pr`, `ndn-ci-readonly`, `ndn-break-glass` (MFA-required, zero permissions). No new role was added by any Phase 1 task; the ten new Lambdas take per-function least-privilege execution roles created by CDK.
- **`ndn-admin` — G0's action item 2, still open.** One IAM user, `AdministratorAccess` attached directly, one access key, created 2026-08-08, still **Active**, and `list-mfa-devices` returns **empty**. Eight days on from G0's recommendation, this is unchanged. It is now the single largest standing credential risk in the estate, and it is a five-minute console action.
- **`803129122420` (legacy/shared):** root keys still in active CLI use — known, tracked as D-28/R-07, owner-deferred. The five legacy IAM roles and six policies that used to live here are gone (2026-08-15). No `nourishthenerve` compute remains; only the Route 53 zone, the inert S3 bucket, and unrelated `islamicmaps` resources.
- **New public surfaces, checked for authz:** two HTTP APIs are now internet-reachable (`tow9lat993`, `m4ptz0to5m`). Every route on them is either flag-gated to `404`, admin-token-gated (`content-authoring`, `workshop-authoring`, `testimonial-moderation`, `media-upload`), or signature-verified (`stripe/webhook`). No route serves data without one of those. The unauthenticated-enumeration class of bug that R-06 was about does not recur here.

### 3a. Finding — the feature-flag system cannot be operated

The most significant finding of this gate, and the reason Phase 1 is not meaningfully live.

`services/api/src/flags.ts` defines `FlagSource` and exactly one implementation, `InMemoryFlagSource`. Nine production handlers construct one and hand it to a `CachedFlagReader`:

```text
contact-form-handler.ts        content-authoring-handler.ts   content-read-handler.ts
media-upload-handler.ts        stripe-checkout-handler.ts     workshop-authoring-handler.ts
workshop-read-handler.ts       testimonial-moderation-handler.ts
testimonial-submission-handler.ts
```

Nothing ever calls `.set()` on any of them. `CachedFlagReader.isEnabled()` therefore resolves `undefined ?? false` on every read, forever. Confirmed against production, not just read from source:

```text
GET  https://m4ptz0to5m.execute-api.eu-west-2.amazonaws.com/content?locale=en   -> 404 {"error":"NOT_FOUND"}
GET  https://m4ptz0to5m.execute-api.eu-west-2.amazonaws.com/workshops?locale=en -> 404 {"error":"NOT_FOUND"}
POST https://tow9lat993.execute-api.eu-west-2.amazonaws.com/contact             -> 404 {"error":"NOT_FOUND"}
aws ssm get-parameters-by-path --path / --recursive  -> only /cdk-bootstrap/hnb659fds/version
```

**This is disclosed, not hidden** — every one of those handlers carries a comment saying exactly this, and each task's Flag line specifies "default off". No one wrote a bug. What happened is that the gap was correctly noted in TASK 1.3.1 and then re-noted, verbatim, in each of the eight tasks that followed, and never became work. That is the pattern a gate review is for.

**Why it is a foundation issue and not a to-do:** D-23 chose homegrown config-driven flags specifically so an operator could dark-launch and then enable without a deploy. As shipped, the flag layer delivers the dark half and none of the enable half — it is functionally `if (false)`. Phase 2 adds authentication and RBAC, which will be flag-gated in the same style; building more on this doubles the eventual retrofit.

**Fixed during this review**, on the owner's go-ahead, as TASK 1.6.2: an `SsmFlagSource implements FlagSource` reading `/ndn/flags/<name>` via `GetParameter`, wired in place of `InMemoryFlagSource` in all nine handlers, with `ssm:GetParameter` on `parameter/ndn/flags/*` added to those execution roles — a prefix wildcard, since naming flags individually would mean a deploy before every flip and reintroduce the coupling being removed, and scoped to stop at the `flags/` segment so it cannot reach any `/ndn/*` secret. The `FlagSource` interface, the 30-second TTL cache and the fail-closed `?? false` default needed no change; this was the implementation the interface was written for in TASK 0.6.1. Reads fail closed on every path — only the literal `'true'` is on, and an unrecognised value or an SSM error warns and resolves off rather than throwing, so a config read can never 500 a working page.

**Every flag is still off.** No parameter was created. The fix restored the ability to turn features on; doing so is a separate decision, and for the two form-backed flags it should wait on a real Turnstile site key (§6).

## 4. Destructive-code audit

- Repo-wide search for `DeleteItemCommand`, `DeleteObjectCommand(s)`, `BatchWriteItem`+`DeleteRequest`, raw `DROP`/`TRUNCATE`/`DELETE FROM`, `s3:DeleteObject*`: **zero hits** outside the lint rule's own fixtures. Phase 1 added ten Lambdas and a DynamoDB table without introducing a single destructive primitive.
- `pnpm lint:no-destructive`: 12/12 fixture violations caught, non-zero exit.
- Soft-delete discipline held: testimonials reject via status, content unpublishes via status, workshops cancel via status. No repository method removes a row.
- **The S3 bucket `nourishthenerve` remains untouched** — 17 objects, 361 MB, versioned, now unreachable (its only reading role was deleted with the Lambda). D-03 forbids deleting it absent an explicit recorded owner override; that override has not been given and this review does not seek one.
- **Repeat finding, worsening — log retention.** G0 §4 found 2 orphaned CloudWatch log groups from destroyed ephemeral PR stacks with no retention policy. There are now **10** (`Pr23`, `Pr25`, `Pr26`×2, `Pr27`×2, `Pr28`, `Pr29`, `Pr30`, `Pr999`), plus the live stack's own two implicit groups (`NdnWebStack-CustomCDKBucketDeployment...`, `NdnWebStack-HealthFunction...`), all still `Retention: None`. The twelve explicitly-constructed `/ndn/*` groups correctly carry 14 days. Total stored: ~47 KB, so £0.00 today — but TASK 0.5.2's DoD ("no log group has infinite retention") is still breached, and the count now grows with every PR that runs a deploy. The fix is the same one G0 recommended and nobody picked up: apply the retention aspect to CDK's implicitly-created Lambda log groups too, and set `removalPolicy: DESTROY` so ephemeral stacks clean up after themselves.

## 5. Actual spend vs model

- **`ndn-prod`, 2026-08-01 → 08-21:** **$0.096** against the $24.21 (£20) budget cap — 0.4% of the envelope, all three alarm thresholds `OK`. By service: S3 $0.044, Cost Explorer API $0.03, API Gateway $0.00026, the rest sub-cent. Ten new Lambdas, a DynamoDB table and two HTTP APIs added essentially nothing, which is what a pay-per-request design at zero traffic should look like.
- **`803129122420`:** Route 53 unchanged at ~$1.00/month across two zones (nourishthenerve's share ~$0.50). The legacy decommission removed a Lambda, a log group and eleven IAM objects — all free tier, so no measurable saving, as the decommission record predicted.
- **Model reconciliation (TASK 1.6.1 step 8) is deferred, correctly.** `03-cost-model.md`'s M1 line items are modelled against *real apex traffic*; the apex serves the legacy site, and every dynamic feature is off, so there is no traffic to reconcile against. This stays open until after the cutover. No price in the model has aged past 90 days since the G0 re-verification.
- No `UNVERIFIED` price became verifiable this phase.

## 6. Security + dependency check

- `pnpm audit --audit-level=high`: no known vulnerabilities.
- Secret scanning: still GitHub-Free-disabled; CI's `gitleaks` job remains the compensating control and runs on every push. Unchanged from G0.
- Branch protection: still unavailable (`403 Upgrade to GitHub Pro`). Merge discipline remains human. Unchanged from G0.
- CSP on the live site is tight and correct — `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, with narrow allowances for Turnstile and Stripe. Full header set present (HSTS with `preload`, `X-Frame-Options: DENY`, `X-Content-Type-Options`, `Referrer-Policy`).
- **New finding — SES production access was DENIED, not pending.** `sesv2 get-account` returns `ReviewDetails: {Status: DENIED, CaseId: 178661888300813}`, `ProductionAccessEnabled: false`. [ses-production-access.md](../runbooks/ses-production-access.md) records it as `PENDING` (true on 2026-08-13) and that record is now stale. The domain identity itself is healthy — `VerifiedForSendingStatus: true`, DKIM `SUCCESS`, signing enabled, SPF/DMARC in place. Consequences, precisely: the **contact form relay would still work** (its recipient is `contact@nourishthenerve.com`, inside the verified domain identity, which the sandbox permits), but **workshop registration confirmations would not** — they go to arbitrary registrant addresses, which the sandbox rejects. Neither is failing in production today because both features are flag-off, but this blocks 1.5.2's DoD the moment they are not. The denial needs an appeal with a fuller use-case description; AWS will have emailed a reason to the account address, which this review cannot read (Basic support blocks the Support API).
- **Open owner action, unactioned — Turnstile.** `apps/web/src/site-config.ts` still ships Cloudflare's public test key `1x00000000000000000000AA`, which passes every challenge by design. The live DOM confirms it, returning `XXXX.DUMMY.TOKEN.XXXX`. This is disclosed in [contact-form.md](../runbooks/contact-form.md) as an explicit owner action; flagging it again so it is not carried silently into the moment `contact.form.enabled` is turned on.

## 7. a11y / i18n on new surfaces

**The gate did not run.** `ci.yml`'s `pr-environment` job carries `&& false` in its `if:` condition, added 2026-08-13 as a deliberate owner decision to save 15–30 minutes of CI wall-clock per PR while the plan worked through many small milestone PRs. That job is the only place `tests/pr-env/a11y-full.test.ts` and `keyboard.test.ts` run. Every Phase 1 UI task from TASK 1.2.1 onward — nav, footer, legal pages, cookie consent, blog, contact, testimonials, workshops — merged without an axe or keyboard check. The job was already informational-only, so even before the pause it could not have blocked a merge.

[ephemeral-pr-environments.md](../runbooks/ephemeral-pr-environments.md) says to re-enable it "before the go-live gate (the cutover in TASK 1.6.1, or whichever milestone review precedes the service going live)" and to promote it into `ci-summary`'s required loop at the same time. **This review is that point.** — **Done 2026-08-21:** both halves landed together on the branch that fixed the suite; the job runs and gates again.

Run by hand for this gate against `https://next.nourishthenerve.com` (`PR_ENV_BASE_URL`, Playwright/Chromium, all 15 routes):

- **axe: clean.** Zero `serious`/`critical` violations on all 15 routes.
- **Cookie consent: clean.** 5/5 — keyboard-operable, decision persists across reload, no cross-origin font request.
- **Keyboard: 25 passed, 4 failed** — `/en/blog`, `/en/workshops`, `/en/testimonials`, `/en/contact`. (**Now 29/29**, after the fixes recorded below; full `pnpm run test:pr-env` against `next.` is 18 vitest + 29 Playwright green.)

Two distinct root causes, diagnosed rather than assumed:

**(a) A real keyboard defect on both form pages.** On `/en/contact` and `/en/testimonials`, walking the actual browser tab order shows **three unnamed, empty elements between the last form field and the submit button** — the inner `<div>`s of the `.cf-turnstile` container. They take focus, have no accessible name, and are invisible. A keyboard user tabs three times into nothing before reaching "Send" / "Submit for review". axe does not catch this (it is a focus-order and name-role-value issue, not a static DOM violation), which is exactly why TASK 1.1.3 specified a keyboard suite alongside axe — the suite worked; it just wasn't running. Worth confirming whether the real Turnstile widget (once the production site key replaces the test key) still produces these stops, since the fix may differ.

**Correction to (a), 2026-08-21 — the diagnosis above was wrong, and the record should say so.** Fixing it required looking at what actually receives the focus, and the answer is not what the gate run reported. `.cf-turnstile`'s contents are replaced by Cloudflare with a **closed shadow root** holding a single cross-origin `<iframe>`. `document.activeElement` retargets every focus stop inside a shadow root to its host element, so from the light DOM all three stops appear to land on one unnamed, empty wrapper `<div>` — which is exactly how they were read. Patching `attachShadow` to open and re-walking the tab order shows the truth: the stop is a **visible 300×65 iframe carrying `title="Widget containing a Cloudflare security challenge"` and `tabindex="0"`**, followed by two focusables inside the widget itself. It is a named, visible, third-party widget behaving normally, not three empty elements. There is no product defect to fix, and no user tabs "three times into nothing". The same closed shadow root is why axe saw nothing — not, as (a) supposed, because this was a focus-order issue axe structurally can't catch.

**What was actually fixed (a):** the test. `keyboard.test.ts` enumerated light-DOM focusables and demanded an exact Tab-for-Tab match through them, which no third-party widget that mounts its own focusables can satisfy. It now treats `.cf-turnstile` as an opaque third-party region — tabbing past its stops, but **bounded** (8), so a genuine trap inside one still fails — and adds a dedicated step asserting the property that (a) was really reaching for: the region is visible, a challenge frame actually attached, and the element taking the keyboard focus carries a non-empty accessible name. Reaching that element needs Playwright's `frameElement()`, which crosses the closed shadow root that `page.locator('iframe')` cannot. Proved by deliberately breaking the name assertion: exactly `/en/contact` and `/en/testimonials` fail, the other ten pass.

**One real thing (a) got right by accident:** its closing note to re-check once a production Turnstile key replaces the test key still stands. The new step is what will answer it — a widget that fails to render, or renders unnamed, now fails the gate instead of passing quietly.

**(b) A symptom of §3a, plus a soft spot in the test.** On `/en/blog` and `/en/workshops` the only `.ndn-button` elements on the page are the **hidden cookie-banner buttons** — because both lists render empty, because the content API is flag-off. The test's "Enter and Space activate a focused button" step calls `.ndn-button.first()`, focuses a `display:none` element (a no-op), and the subsequent `Enter` lands on whatever still held focus: the footer's last link, navigating to `/en/legal/clinical-disclaimer`. So the assertion failure is real but the diagnosis is two-part — the pages are empty because of the flag gap, and the test should assert on a *visible* button rather than the first matching one. Both halves want fixing; neither is the "buttons don't respond to Enter" defect the failure message suggests.

**Fixed (b), 2026-08-21.** The step now selects the first *visible* `.ndn-button`. Where a route has none — `/en/blog` and `/en/workshops`, both empty because of §3a — it does not skip quietly: it asserts that every `.ndn-button` on the page is one of the cookie banner's hidden two, so a route that loses a visible button for any other reason still fails, and it records an annotation naming the flag gap as the reason. Running the two form routes' button step for the first time (they had failed earlier and never reached it) surfaced a third, smaller test defect: `Enter` on a real `type="submit"` button fires the click and then native constraint validation moves focus to the first invalid required field, so the chained `Space` press landed in a text input. Correct browser behaviour; the test now re-focuses the button before the second key press, since the claim under test is "a focused button is activated by Space", not "focus survives the previous activation".

**Core Web Vitals — measured and passing** (actioned during this review, on the owner's go-ahead: no Lighthouse existed in this environment, and substituting a weaker proxy would not have been a pass). `@lhci/cli` now lives in the repo with the bar encoded in `lighthouserc.json` — the plan says "Gate G1's bar" and gives numbers nowhere, so it is defined as Google's "good" thresholds (LCP ≤ 2500 ms, CLS ≤ 0.1, FCP ≤ 1800 ms) plus TBT ≤ 200 ms, performance ≥ 0.90 and accessibility **= 1.00**.

All six main routes on `next.`, desktop preset: **performance 100, accessibility 100, SEO 100**, LCP 285–414 ms, CLS ≤ 0.01, TBT 0 ms throughout — every assertion passing with 6–9× headroom on LCP. Full table and method in `docs/runbooks/core-web-vitals.md`, added on that branch.

Three honest limits on what that proves. It is a **floor, not a forecast**: every dynamic feature is flag-off (§3a), so blog/workshops/testimonials render empty lists and none of these pages fetches anything — images are the usual LCP regression and there are none yet, so the run worth having is the one after real content publishes. It is `next.`, not the apex, though both are the same distribution and origin. And INP is a field metric no lab tool can produce; TBT is the standard stand-in, named as such rather than quietly reported as INP.

**One finding from it:** best practices scores 96, not 100, on **every** page for exactly one reason — `GET /favicon.ico` returns 404 and Chrome logs a console error. There is no `apps/web/public/`, no icon asset and no `<link rel="icon">` in `BaseLayout.astro`: never added, rather than added and broken. Cosmetically it is a blank tab icon everywhere. Owner action, since which mark to use is a brand decision.

**i18n:** English-only, correctly. Every user-facing string goes through `t()`, enforced by `ndn/no-hardcoded-strings` in the required lint gate. `Locale` is a single-member union and `rtlLocales` is deliberately empty — the seams exist, no second language is claimed. No hard-coded copy found in the live DOM outside the catalogue.

## 8. Production health

- `next.nourishthenerve.com`: all 15 routes `200`. `/health` → `{"status":"ok","version":"4c7dedf..."}` — `main`'s last code-bearing commit (`d64a5b1` was docs plus AWS-side work, correctly path-filtered out of a deploy).
- CloudWatch alarms: `HealthAliasErrorsAlarm`, `HealthAliasLatencyAlarm`, `ndn-log-ingestion-volume` — all `OK`.
- Stacks: `NdnWebStack`, `NdnDataStack`, `NdnBudgetStack` all `UPDATE_COMPLETE`; `CDKToolkit` `CREATE_COMPLETE`. No ephemeral `Pr*` stacks linger.
- `NdnWebStack`'s distribution is `Deployed`, carrying `next.nourishthenerve.com` as its only alias with the three-SAN certificate attached — the deliberate decoupling from TASK 1.6.1's fix, holding as intended.
- Legacy apex: `302` → `www`, `www` `200`, still served by the third account's distribution. Untouched, as it must be until AWS releases the alias.
- **Rollbacks this phase: one**, the PR #38 `deploy` job (2026-08-14). CloudFormation rolled `NdnWebStack` back cleanly and automatically; `next.` never stopped serving. The only real user-facing outage window in Phase 1 was the ~72 seconds on 2026-08-15 during the owner-approved cutover attempt, fully recorded in [g1-cutover.md](../runbooks/g1-cutover.md).

## 9. Files changed by this gate pass

- `docs/plan/gate-g1-report.md` — this report.
- `docs/runbooks/ses-production-access.md` — corrects a stale `PENDING` to the actual `DENIED` (§6).

Actioned separately, during the review, on the owner's go-ahead — each on its own branch:

- **`SsmFlagSource`** (§3a's fix) — the flag layer can be operated again. Every flag remains off.
- **`@lhci/cli` + `lighthouserc.json` + `core-web-vitals.md`** (§7) — G1's third criterion, measured and passing.
- **`tests/pr-env/keyboard.test.ts` + `ci.yml` + `ephemeral-pr-environments.md`** (§7's corrections, action items 2 and 3) — the keyboard suite fixed and the a11y gate re-enabled and made blocking. This report's §7 amended in the same change to correct (a)'s diagnosis.

Phase 2's stubs are **not** elaborated in this pass. D-27 elaborates the next phase at each gate, and this gate is a no-go; elaborating Phase 2 against a foundation with an inoperable flag layer would bake that assumption into fourteen task specs. Elaborate it once §3a is fixed — the fix is small and does not depend on the cutover.

## Action items

**Before Phase 2 work lands (engineering, no owner action needed):**

1. ~~Build `SsmFlagSource` and wire it into the nine handlers~~ — **done during this review** (§3a), on its own branch. Flags all remain off; the ability to turn them on is what was restored.
2. ~~Re-enable `pr-environment` and promote it into `ci-summary`'s required gate~~ — **done 2026-08-21** (§7). Both halves landed together, as [ephemeral-pr-environments.md](../runbooks/ephemeral-pr-environments.md) always said they should. Every code-touching PR now pays the ~15–30 minute distribution cycle again, and an a11y or keyboard regression blocks the merge; docs-only PRs still skip it on the path filter.
3. ~~Fix the "three unnamed focus stops" on the Turnstile container (§7a), and tighten `keyboard.test.ts` to select a *visible* button (§7b)~~ — **done 2026-08-21**, with a correction: (a) was misdiagnosed. There is no product defect — the stops belong to a visible, accessibly-named cross-origin widget hidden behind a closed shadow root. The fix is in the test, plus a new assertion that the widget really is visible and named. See §7's correction; keyboard is now 29/29.
4. **Fix the log-group retention leak** (§4) — repeat finding, five times larger than at G0, and it grows per PR. **Still open — the last of the four.**

**Owner actions:**

1. **Add an MFA device to `ndn-admin`** (§3). Repeat of G0's action item 2, still open, still five minutes, still the largest standing credential gap.
2. **Appeal the SES production-access denial** (§6), case `178661888300813` — AWS's reason will be in the account's email. Blocks workshop confirmation emails, and therefore 1.5.2's DoD, whenever those features go live.
3. **Replace the Turnstile test site key** with a real widget's key before `contact.form.enabled` or `testimonials.submission.enabled` is ever turned on (§6).
4. **Supply a square logo/mark** so a favicon can be added (§7) — the one thing docking every page's best-practices score, and a blank browser-tab icon on every page today. Two-minute follow-up once the asset exists.
5. **The AWS support case** for the apex alias (`nourishthenerve.com` / `www` → `E1K6OYW4X46BJZ`) is filed and awaiting reply. Poll `cloudfront list-conflicting-aliases` for `Quantity: 0` rather than retrying a deploy; the runbook explains why.
