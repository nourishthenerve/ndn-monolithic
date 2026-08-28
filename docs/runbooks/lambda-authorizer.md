# The Lambda authorizer (TASK 2.2.2)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.2.2](../plan/05-execution-plan.md) · **Milestone:** M2.2 · **Requirements:** NFR-03, NFR-05, NFR-06 · **Decisions:** D-06 · **Risks:** R-09 · **Depends on:** 2.2.1, 2.1.1, 2.1.3

**The "Protected unless it says otherwise" table below is superseded by [TASK 2.5.4](admin-token-retirement.md), 2026-08-22.** `ADMIN_TOKEN_ROUTE` and `ADMIN_TOKEN_ROUTE_KEYS` are deleted — the thirteen routes that stood behind them now sit behind this same authorizer, described here. See the linked runbook for the current route count and the one behavioural wrinkle (`GET /testimonials` splitting off `GET /testimonials/pending`) that migration required.

## The invariant

> No protected route is reachable without a verified token from a known pool. The role a request runs as comes from the issuer, not from anything the caller can set. Every failure mode denies.

## Why a Lambda authorizer at all

TASK 2.2.1's two pools mean two issuers. API Gateway's built-in JWT authorizer binds **one issuer per authorizer and one authorizer per route**, so it cannot serve both — that is the named cost of the two-pool decision ([ADR-0004](../adr/0004-auth.md)), and this is the function that pays it.

It is also the only place in the repository that parses a JWT. No handler reads the `Authorization` header, ever; `request-principal.ts` exists so a handler cannot be tempted to.

## What was built

| File | What it is |
|---|---|
| `services/api/src/jwt-verify.ts` | Verification. Two `aws-jwt-verify` verifiers, one per pool, tried in turn. |
| `services/api/src/authorizer.ts` | The decision. SDK-free and unit-tested — verifier and directory are injected. |
| `services/api/src/dynamo-principal-directory.ts` | One `GetItem` for the account status. |
| `services/api/src/authorizer-handler.ts` | Wiring, plus the outermost catch that makes a crash a denial. |
| `services/api/src/request-principal.ts` | `requirePrincipal(event)` — how a handler gets its caller, and the only way it can. |
| `infra/src/route-protection.ts` | Which routes are outside the authorizer, and which of two reasons applies. |
| `infra/src/data-stack.ts`, `web-stack.ts`, `bin/app.ts` | One authorizer function, both APIs. |

## The role comes from the key set, not from a claim

The plan's hardest requirement is that a caller's role is not something the caller can assert. Two ways to satisfy it:

- a single multi-pool verifier, then read `iss` from the verified payload — correct, but the guarantee is something you reason about *afterwards*;
- **two single-pool verifiers, tried in turn** — the pool is not read from the token at all. It is whichever verifier's key set validated the signature.

The second is what `jwt-verify.ts` does. A token minted by the patient pool cannot come back as a clinician, because the clinician verifier will not verify it. The only thing a claim decides is `principal-clinician` versus `sub-clinician`, from `cognito:groups` — which only an admin API call can set, never the token holder. There is a named test for a patient-pool token carrying `cognito:groups: [principal-clinician]`; it resolves to `patient`.

`token_use` is pinned to **`access`** and only `access`. The ID token is a statement *to the client* about who signed in; the access token is the credential presented *to an API*. Both are signed by the same keys and both carry `sub`, so accepting either would work — and would make the token the browser holds for its own rendering a credential against every route.

## Every failure denies, including the ones that are not about the token

```text
no Authorization header            -> deny (no-bearer-token)
Bearer with an empty token         -> deny (no-bearer-token)
a scheme that is not Bearer        -> deny (no-bearer-token)
expired / wrong key / alg:none /
  RS256 re-signed as HS256 /
  other pool's issuer / wrong aud /
  wrong token_use                  -> deny (token-not-verified)
JWKS endpoint unreachable          -> deny (token-not-verified)
verified token with no `sub`       -> deny (token-not-verified)
DynamoDB throttled or unavailable  -> deny (lookup-failed)
no PAT#/CLI# record for the sub    -> deny (no-directory-record)
any unexpected throw               -> deny (authorizer-error)
```

**A 500 is a denial, not an allow.** API Gateway does turn an unhandled authorizer exception into a refusal, but that would make the property a fact about API Gateway rather than about our code. `authorizer-handler.ts` catches everything and returns an explicit `isAuthorized: false`, so it is assertable — and asserted, in the test named for it.

Every denial returns an **empty context**, so nothing downstream can read a half-built principal.

## What is logged, and what cannot be

One structured line per decision: route, allow/deny, and on an allow the subject id, pool and role. Never the token. Never a claim body. Never an email address — nothing on the path carries one, because `dynamo-principal-directory.ts` projects `account_status` and nothing else out of the profile row, so neither `personal{}` nor `clinical{}` is ever in this function's memory (R-09's "a log line").

A token that failed verification is logged **without** its subject. An unverified token's `sub` is a string the caller chose, and logging it would put attacker-controlled data in the trail dressed as an identity. There is a test for that, and one asserting no line ever contains the token.

## The five-minute cache window, stated rather than discovered

`resultsCacheTtl` is 300 seconds — API Gateway's maximum for a REQUEST authorizer, and the value the plan names. The cache is keyed on the `Authorization` header, so:

> **A token revoked right now still authorises for up to five minutes.**

That is the window TASK 2.2.1's `enableTokenRevocation` shortens from the access token's full hour, not one it removes. When TASK 2.4.1 deactivates a clinician, the account is disabled and the refresh token revoked immediately, but an access token already in flight keeps working until its cached decision expires. If a deactivation is urgent — a compromised account rather than a leaver — the operator action is to disable the Cognito user *and* wait out the window before declaring the session closed.

Lowering the TTL would put a Lambda invocation on every authenticated request. Raising it is not possible.

## Account status travels on the Principal — and is not enforced here

The authorizer reads `account_status` once and puts it on the `Principal`, so a suspended patient stops working within the cache window rather than at their next sign-in. It does **not** deny on it.

That is deliberate. `can()` (`authz.ts`) gates a non-operative status down to *reading one's own profile* rather than to nothing, which is what lets a declined or suspended person still see their own account. An authorizer that denied on status would take that away, and would put a second, divergent copy of the policy on the request path — the exact scattering TASK 2.1.1 built the matrix to prevent.

## Protected unless it says otherwise

Both HTTP APIs set `defaultAuthorizer`. A route added without thinking about authentication is **closed**, not open. Opting out means naming one of two constants at the call site *and* adding the route key to `route-protection.ts`, and the synth tests fail if those two disagree.

| Reason | Meaning | Count today |
|---|---|---|
| `PUBLIC_ROUTE` | No caller identity by design — a blog reader, a testimonial submitter, a workshop buyer, and Stripe (which authenticates by signature, not token) | 7, at TASK 2.2.2 |
| `ADMIN_TOKEN_ROUTE` | *(Historical.)* Behind `admin-auth.ts`'s single shared bearer secret at TASK 2.2.2's own time. Retired by TASK 2.5.4 — the construct and every route that opted out through it are gone; see [admin-token-retirement.md](admin-token-retirement.md) for where those thirteen routes (fourteen counting `GET /testimonials/pending`, new at 2.5.4) sit now. | 13, at TASK 2.2.2 |

`ADMIN_TOKEN_ROUTE_KEYS` was TASK 2.5.4's work list, as data, before that task deleted the export along with the construct it named. **It contained one route 2.5.4's own text did not:** that task named four functions (content authoring, workshop authoring, testimonial moderation, media upload), which is thirteen routes — and missed `GET /audit`, added later by TASK 2.1.3 behind the same shared secret. It was in the list so 2.5.4 would find it by reading the file rather than by remembering — and it did.

## Nothing is protected yet, and that is the honest state

Two facts a reader should not have to discover:

1. **No route on either API is behind the authorizer today.** TASK 2.2.3's registration endpoints are the first. Both stacks' tests assert the current set is empty, so when those assertions start failing, that is 2.2.3 landing rather than a regression.
2. **CDK therefore synthesizes no `AWS::ApiGatewayV2::Authorizer` resource.** The construct materialises when a *route* binds it; `defaultAuthorizer` alone does not, because every route currently overrides it with `HttpNoneAuthorizer`. The authorizer **function** deploys and runs; the API-Gateway-side resource appears with 2.2.3.

And a third, which matters more: **every valid token denies today.** The directory lookup requires a `PAT#<sub>` or `CLI#<sub>` profile row; TASK 2.2.3 creates the first of those and TASK 2.4.1 the first of these. A Cognito user with no record in this system is not a principal, and the authorizer is not the place to make an exception for the fact that the system is new.

## A key-shape decision this task makes, which constrains TASK 2.4.1

The status lookup is one `GetItem` at `PAT#<cognito-sub>` / `PROFILE` or `CLI#<cognito-sub>` / `PROFILE`. The patient side matches what TASK 2.2.3 is already specified to create ("keyed by the pool's `sub`"). The clinician side is a constraint this task imposes, because TASK 2.4.1 as written creates the `CLI#` record *before* calling `AdminCreateUser`, when no sub exists yet.

Three ways to link them, and the reasoning for the one chosen:

| Option | Verdict |
|---|---|
| A custom Cognito attribute holding the record id | **No.** TASK 2.2.1 put exactly one attribute on those pools; a second reopens "no personal data in the directory". |
| A GSI on `cognito_sub` | **No.** A whole index on the estate's smallest partition, read once per cold authorisation. |
| **Key the `CLI#` record by the sub** — 2.4.1 calls `AdminCreateUser` first, then writes `CLI#<sub>` | **Yes.** |

2.4.1's stated reason for writing the record first is that "an orphaned Cognito user is the failure mode rather than an orphaned record". **That reason survives the reordering**: a Cognito user with no `CLI#` row is precisely what this authorizer denies. The failure mode it wanted is the one it still gets. The constraint is written at the top of `dynamo-principal-directory.ts` as well as here, so 2.4.1 meets it or changes it deliberately.

## Least privilege

The authorizer's role holds **one** data-plane action: `dynamodb:GetItem`, conditioned on `dynamodb:LeadingKeys` matching `PAT#*` or `CLI#*`. Not `grantReadData()`, whose action list also carries `Query`, `Scan` and `BatchGetItem`. This function is on the path of every authenticated request in the estate, so anything broader here would be the widest-blast-radius grant in the repository. It also carries 0.3.2's destructive-action guardrail and 2.1.3's audit-partition denial — it never writes an audit row, so that partition is closed to it like every other non-reader role.

## Log group and the alarm budget

`/ndn/authorizer-function` joins `MONITORED_LOG_GROUP_NAMES`, **displacing `/ndn/media-upload-function`** into the unmonitored list. `config.ts`'s own instruction requires naming what a new entry displaces, and the comparison is: the authorizer sits on the path of every authenticated request, media upload is an admin-gated action a clinician performs when publishing a workshop image. If either is going to run away, it is not the one a human triggers by hand. Media upload keeps its 14-day retention; its bytes are simply no longer summed into the volume alarm.

## Cost

**£0.00 net-new.** One more 128 MB arm64 function inside the always-free Lambda allowance, with authorizer results cached for five minutes so it is not invoked per request. One `GetItem` per cache miss, inside `03-cost-model.md`'s existing DynamoDB line. `aws-jwt-verify` adds ~40 KB to one bundle.

## Verification

- `pnpm -r lint && pnpm -r typecheck && pnpm test` — green. `services/api` 580 → **659** tests; `infra` 164 → **174**.
- `pnpm --filter @ndn/infra run synth` — all four stacks.
- **Verified live, 2026-08-28** — found during TASK 5.5.2's runbook consolidation pass: this note deferred verification to 2.2.3/2.5.x, both long complete. The real-world proof landed as a side effect of TASK 5.3.1/5.3.2's own live-session accessibility suite (`live-session-accessibility.md`) — a real, signed-in clinician token hitting both clinician-owned routes (`caseload`, 200) and patient-owned ones (`patient`, `content` — a real, legible 403/forbidden state, not the unauthenticated-route case this task's own original wording pictured). Not re-run as a standalone check; the equivalent claim is what that suite's own nightly green run already proves.

## Rollback

Revert the branch. Nothing depends on the authorizer yet — no route binds it, so reverting removes a deployed function and two unused authorizer configurations and changes no request path. The `defaultAuthorizer` wiring reverts with it, and every route returns to being unprotected-by-default, which is the state this task found.

## Do not

- Trust any claim for role that a client could influence.
- Read the `Authorization` header in a handler.
- Cache a decision longer than the token's own life.
- Return `Allow` on an internal error.
- Log a token or a claim body.
- Disable `enableTokenRevocation` to make the cache window simpler to reason about.
