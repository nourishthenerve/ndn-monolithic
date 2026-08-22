# The authenticated web shell (TASK 2.2.4)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.2.4](../plan/05-execution-plan.md) · **Milestone:** M2.2 · **Requirements:** FR-X-02, NFR-03, NFR-06 · **Decisions:** D-08, ADR-0017, ADR-0003 · **Depends on:** 2.2.1, 2.2.2, 1.1.1, 1.1.2

## The invariant

> A patient can sign in and out on the real domain. No token is reachable from script. Protected content never reaches the DOM unauthenticated.

## The problem this shape solves

D-08 and ADR-0017 put the site on S3 + CloudFront with **no server runtime**, which collides with the only good place to keep a refresh token. There is no origin server to set an `HttpOnly` cookie, so the obvious paths — `localStorage`, `sessionStorage` — leave a long-lived credential to a patient's clinical record readable by any script that reaches the page. 1.2.3's strict CSP mitigates that; it does not remove it, and it is not an acceptable trade on this data.

**Resolution: a token-exchange endpoint on the existing HTTP API, proxied same-origin through CloudFront** — the identical shape `/health` and `/contact` already use. The browser gets an authorization code, posts it to `/auth/token` on its own origin, and a Lambda performs the PKCE exchange and answers with `Set-Cookie: HttpOnly; Secure; SameSite=Lax`.

## The flow

```text
[sign in] ─GET /auth/signin──▶ Lambda: mint PKCE verifier + state
                               Set-Cookie ndn_pkce, ndn_state (HttpOnly)
                               302 ─▶ <pool>.auth.eu-west-2.amazoncognito.com/oauth2/authorize

                       patient enters their one-time code on Cognito's page

  ─302 back to /en/account/callback?code=…&state=… ─▶ island posts to /auth/token
                               Lambda: check state cookie, exchange code + verifier
                               Set-Cookie ndn_refresh (HttpOnly, 30d); clear the one-time pair
                               body: { accessToken, expiresIn }   ← held in a closure, never stored

  later ──POST /auth/refresh──▶ new access token from the cookie the browser cannot read
  [sign out] ─POST /auth/signout──▶ revoke at Cognito, then clear every cookie
```

## Four routes where the plan named three

`/auth/token`, `/auth/refresh` and `/auth/signout` are the plan's. **`GET /auth/signin` is not**, and it exists because of the plan's own constraint.

PKCE needs a verifier generated before the redirect to Cognito and read back after it. The two obvious homes are `sessionStorage` — forbidden by this task's own "Do NOT" list — and an in-memory variable, which a full-page redirect destroys. Generating it server-side and parking it in an `HttpOnly` cookie is the only place left where script cannot reach it. **Every secret in this flow is out of script's reach, not merely most of them.**

It being a `GET` that redirects is a second, smaller win: the sign-in control is an ordinary anchor. It works with JavaScript disabled, it is keyboard- and screen-reader-reachable because it is a link, and there is no click handler for the a11y suite to catch out.

## Cookies, and why each attribute is there

| Attribute | Why |
|---|---|
| `HttpOnly` | Script cannot read it. This is the whole design. |
| `Secure` | It never travels over plaintext. |
| `SameSite=Lax` | A cross-site `POST` does not carry it. |
| `Path=/` | Site and API are one origin (CloudFront proxies `/auth/*`), so a narrower path would only be a way to lose the cookie after a rename. |
| *no* `Domain` | Host-only on the apex, so `next.nourishthenerve.com` — the same distribution under another name — never receives the session. |

A table-driven test asserts all four on every cookie every route sets, so dropping one fails rather than passing a partial match.

**CSRF, stated rather than implied.** `SameSite=Lax` means a cross-site form post does not carry the cookie, and `/auth/token`, `/auth/refresh` and `/auth/signout` are `POST`-only. An attacker's page can therefore neither read the cookie nor make the browser send it on a request they forged. That is why `GET /auth/signin` *sets* cookies rather than spending one — a `GET` that carried the refresh cookie would break the property, because `Lax` does allow top-level `GET` navigations.

The refresh cookie's `Max-Age` is exactly 30 days, matching TASK 2.2.1's `refreshTokenValidity`. A cookie that outlives its token is a lie to the browser.

## The access token lives in a closure

`apps/web/src/auth/session.ts` holds it in a local variable inside `createSessionClient`. Not on `window`, not in a module-level mutable export, not in any storage. The client exposes four methods and no accessor; a test asserts the key list and that nothing new appears on `globalThis`.

**One refresh, never a loop.** A single in-flight promise is shared, so two islands mounting at once do not each spend the cookie, and a *failed* refresh does not retry itself. Four tests cover it: concurrent resolves make one call, a cached token makes none, an expired one makes exactly one more, and two failures in a row make two calls rather than an unbounded run.

**No browser storage anywhere.** `apps/web/src/auth/no-browser-storage.test.ts` scans the auth sources *and* every built bundle in `dist/`, because that is where the mistake actually lands — a dependency or a future "just cache the token" refactor shows up in the bundle whether or not it is visible in `src/auth`. Two rules, because the APIs are not equally out of bounds: `localStorage`/`sessionStorage` are forbidden **site-wide** (nothing legitimately uses either today), and `document.cookie` is forbidden **on auth paths only** — the cookie-consent banner from 1.2.3 legitimately uses one and it is not a session.

## Protected content never reaches the DOM

`RequireAuth` renders `null` until the session resolves. Not `hidden`, not `display: none`, not opacity — a protected fragment that is in the DOM and merely invisible is one anybody can read with a devtools panel or a screen reader that ignores the styling.

The *page* stays statically generated and empty, so ADR-0017's static-output decision is intact: what makes `/en/account` private is not server rendering but that its content is not in the HTML at all.

While resolving, the island renders a `role="status" aria-live="polite"` line, so a screen-reader user is told the page is working — the same information a sighted user gets from the text.

## Where the one-time code is entered, and what that costs

**On Cognito's managed-login page, not ours.** That is a direct consequence of the authorization-code flow this task's Resolution chose: the browser must arrive at `/oauth2/authorize` and come back with a `code`, and the credential entry happens in between, on Cognito's origin.

The honest consequence: **the OTP field is outside our axe and keyboard suites.** The plan's step 8 asks for a test on it; what we can test is every state we own — the sign-in link, the callback's exchanging/failed states, sign-out, and the loading and signed-out states of `RequireAuth`. The OTP page itself is AWS's, on AWS's domain, and no test in this repository can reach it.

The alternative — proxying Cognito's challenge flow through our own Lambda so we could render our own OTP field — was not taken, because it means reimplementing sign-in as a bespoke challenge state machine against `InitiateAuth`/`RespondToAuthChallenge`, which is precisely the "self-rolled auth on health data" ADR-0004 rejected in its first line. If the managed login page proves inaccessible in practice, that is the trade to revisit, deliberately, with the a11y finding in hand.

`ManagedLoginVersion.NEWER_MANAGED_LOGIN` is required, not preferred: passwordless email OTP is only offered by the newer pages, so the classic hosted UI would show a patient a password box for an account that has no password.

## The hosted domains, deferred from 2.2.1 and taken here

TASK 2.2.1 deliberately created no user pool domain ("2.2.4 decides whether it needs the hosted UI at all"). The answer is yes: `/oauth2/authorize`, `/oauth2/token` and `/oauth2/revoke` all live on it and none exists without it.

Cognito-prefix domains (`ndn-patients`, `ndn-clinicians`) rather than custom ones. A custom domain needs its own ACM certificate in `us-east-1` and a DNS record in a hosted zone that lives in **another AWS account** ([iac-baseline.md](iac-baseline.md)) — a manual cross-account step, for cosmetics on a page a patient sees for seconds. **These prefixes are globally unique per region across all AWS accounts**; if the deploy fails claiming one is taken, the fix is a new prefix in `config.ts`, not a retry.

## Sign-out revokes, it does not merely forget

`POST /auth/signout` calls Cognito's `/oauth2/revoke` before clearing the cookie. Dropping the cookie alone would leave a live credential in whatever captured it; TASK 2.2.1 turned `enableTokenRevocation` on for exactly this call.

A revocation failure is swallowed and the cookie still goes: a sign-out that appears to fail is worse than one whose server-side half needs retrying. Note the interaction with the authorizer's five-minute result cache ([lambda-authorizer.md](lambda-authorizer.md)) — an access token already in flight keeps working until its cached decision expires, so "signed out" is immediate for the browser and up to five minutes for a captured token.

## Least privilege

The auth function holds **one** permission: `ssm:GetParameter` on the flag prefix. No table, no bucket, no Cognito grant — the `/oauth2/*` endpoints are ordinary OAuth 2.0 endpoints taking form posts from a public client, so there is nothing to sign and no credential to hold. A test asserts its role's policy contains exactly `ReadFeatureFlags`.

Plain `fetch` rather than the Cognito SDK for the same reason: pulling in a service client to post a form would add a megabyte to the bundle for nothing. Cognito's error bodies are never surfaced or logged — an OAuth error response echoes request parameters, which on this path include a code and a refresh token.

## Flag and rollback

`auth.webSignIn.enabled`, **default off**. With it off, all four routes answer `404` before anything else happens and the site is exactly the brochure it is today. The account pages still build and still render — as a loading state that resolves to signed-out, which is the correct thing for a page whose sign-in route does not exist.

```bash
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/auth.webSignIn.enabled --type String --value true
```

Rollback is the same command with `false`. Sign-in disappears; the static site is unaffected.

## Verification

- `pnpm -r lint && pnpm -r typecheck && pnpm test` — green. `services/api` 699 → **734**; `infra` 183 → **188**; `apps/web` 52 → **66**.
- `pnpm --filter @ndn/web run build` — 18 pages, including `/en/account` and `/en/account/callback`; a grep of `dist/` finds no `localStorage` or `sessionStorage` anywhere.
- **Not yet run**, and named rather than reported as done: the plan's browser check (a full sign-in leaves no token in `localStorage`/`sessionStorage`, checked in the browser rather than inferred; a captured cookie stops refreshing after sign-out) needs the flag on, a deployed pool domain, and mail that can leave the account — SES production access was denied on 2026-08-21 ([ses-production-access.md](ses-production-access.md)), so no patient can receive a sign-in code yet. The same gate as [patient-registration.md](patient-registration.md).
- The pr-env a11y suite covers the new routes' loading, signed-out, callback and error states. The OTP field is Cognito's page and is out of its reach — see above.

## Do not

- Put any token in `localStorage` or `sessionStorage`.
- Add a non-`HttpOnly` auth cookie.
- Make the account pages server-rendered.
- Hard-code a user-facing string — the i18n lint rule is in the required gate.
- Bypass `RequireAuth` for a "quick" preview page.
- Give `GET /auth/signin` anything to spend: it sets one-time cookies and must never read the refresh cookie, or `SameSite=Lax` stops covering CSRF.
