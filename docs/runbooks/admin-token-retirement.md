# Retiring the `ADMIN_API_TOKEN` bearer gate (TASK 2.5.4)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.5.4](../plan/05-execution-plan.md) · **Requirements:** NFR-03, NFR-06 · **Risks:** R-07 · **Depends on:** 2.2.2, 2.4.1

## What this covers

`services/api/src/admin-auth.ts` said, since TASK 1.3.2, exactly what it was: "one narrow, explicitly-temporary bearer-token gate… no user identity, no session, no scopes — just 'did the caller present the one shared secret'… **Superseded by Phase 2's Cognito RBAC**." Five production routes stood behind it — content authoring (4 routes), workshop authoring (4), testimonial moderation (3, including the overloaded `GET /testimonials`), media upload (1), and `GET /audit` (1, added by TASK 2.1.3 after this task was already elaborated). This task moves all of them onto the real Lambda authorizer (TASK 2.2.2) and `can()`, and deletes the gate.

## The RBAC rows this needed, and the design decision inside them

Content items, testimonial moderation and workshops are clinic-wide marketing/admin resources with no patient relationship to scope by — unlike every row `docs/plan/04-data-model-rbac.md`'s matrix already had. Three new rows settle who may act on them (`docs/plan/04-data-model-rbac.md`, transcribed in `authz-matrix.ts`):

| Entity | Patient (own) | Patient (other) | Sub-clinician (assigned) | Sub-clinician (unassigned) | Principal |
|---|---|---|---|---|---|
| Content item | — | — | C R U | C R U | C R U |
| Testimonial moderation | — | — | C R U | C R U | C R U |
| Workshop | — | — | C R U | C R U | C R U |

**`Sub-clinician (assigned)` and `Sub-clinician (unassigned)` are the identical cell on purpose.** "Assigned to a patient" has no meaning for a blog post — a sub-clinician principal always lands in the `unassigned` column for these three rows (no code ever sets `assignedClinicianId` on one), so both columns carry the same grant rather than leaving an asymmetry nothing production ever exercises.

**Any clinician, not principal-only — a deliberate reading of the task's own text.** Step 1 says "clinician-role authorisation replacing 'presented the secret,'" not "principal-clinician-role." Read literally, that is *a* clinician, not *the* principal clinician specifically — and it is also the least-surprising choice given the retired shared secret never distinguished between staff members either: anyone who held it could act. `authz.test.ts`'s exhaustive suite covers all three rows the same way it covers every other; one dedicated test (`'a sub-clinician reaches nothing belonging to a patient they are not assigned'`) excludes these three from its blanket "unassigned is always denied" premise, with a comment explaining why the premise doesn't apply here.

`POST /workshops/media-upload-url` reuses the **Workshop** row rather than getting its own — a presigned poster upload has no independent existence from the workshop it is for.

## `GET /testimonials`'s overload could not survive the migration as written

The task's own Interfaces line says "unchanged — same routes, same request and response shapes, different authentication." That held for content, workshop, and the two testimonial POST routes. It did not hold for `GET /testimonials`.

Before this task, `GET /testimonials` served two audiences on one path: no `status` query param (or anything but `pending_review`) returned published testimonials, **unauthenticated, no flag gate**; `?status=pending_review` was the admin-token-gated moderation queue. `ADMIN_TOKEN_ROUTE` and `PUBLIC_ROUTE` were both, mechanically, just `HttpNoneAuthorizer` — neither was a real API-Gateway-level gate, so the same path could carry both behaviours and the handler's own internal branch was the only real boundary.

The real Lambda authorizer is not that permissive. `authorizer.ts`'s own header states the invariant plainly: "there is no path through this function that returns `isAuthorized: true` without a verified token *and* a resolved record." A route bound to it 401s an anonymous caller before the Lambda handler runs at all — API Gateway rejects on a missing/unverifiable `Authorization` header without ever invoking the integration. Putting `GET /testimonials` behind this authorizer would have broken the public testimonial listing outright; leaving it on `PUBLIC_ROUTE` would have made the moderation queue permanently unreachable by a real, verified principal, since a publicly-routed request never carries an authorizer context to read.

**Resolution: the queue moved to its own path, `GET /testimonials/pending`.** `GET /testimonials` stays exactly as public as it always was — now structurally, not just by the handler's internal branch (it moved from `ADMIN_TOKEN_ROUTE_KEYS` to `PUBLIC_ROUTE_KEYS` in `route-protection.ts`, reflecting what was already true). `GET /testimonials/pending` takes no `authorizer:` override at all and falls to `defaultAuthorizer` (the real one), same as every other migrated route. Both routes are served by the same `TestimonialModerationFunction` — no new Lambda, one new API Gateway route.

## A real correctness gap this migration would otherwise have opened: `MediaUploadFunction` in an ephemeral PR stack

`MediaUploadFunction` lives in `web-stack.ts`, whose `HttpApi` receives its `authorizerFunction` as an **optional** prop — `undefined` for an ephemeral per-PR stack, which deploys no `DataStack` and therefore has no authorizer function to share. Before this task that was safe regardless: the route opted out explicitly with `ADMIN_TOKEN_ROUTE`, a static construct needing no authorizer function to exist.

Simply removing that override — as the other twelve routes' migration did — would have left the route relying on `defaultAuthorizer`, which is `undefined` in the ephemeral case. An API Gateway route with no authorizer at all synthesizes with `AuthorizationType: NONE`: **wide open**, not merely "unauthenticated in the deliberate way `PUBLIC_ROUTE_KEYS` means it." An ephemeral PR stack would have deployed a presigned-upload endpoint reachable by anyone, into a real S3 bucket, for the lifetime of the PR.

Fixed by gating the entire `MediaUploadFunction` block — the role, the function, the route — behind `if (props.authorizerFunction)`, the same shape `web-stack.ts` already uses for `StripeWebhookFunction`'s `if (props.table)`. An ephemeral PR stack now builds no media-upload function and no route for it at all, rather than one with no real gate. `web-stack.test.ts`'s own `synthWithTable()` helper had never actually passed `authorizerFunction` through in the first place (a pre-existing gap this task's own change made matter for the first time) — fixed alongside, and the same fix applied to `log-retention.test.ts`'s production-app helper, which had the identical gap.

## What was built

- **`services/api/src/content-authoring.ts`, `workshop-authoring.ts`, `testimonial-moderation.ts`, `media-upload.ts`** — `verifyAdminToken`/`getAdminToken` replaced with `requirePrincipal(event)` (401 on failure, checked before any repository/S3 call, same ordering the token check had) and a `can(principal, action, RESOURCE)` check per route (403 on denial). Each handler's return type widened to `APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined>`. The audit actor is now `actorFromPrincipal(principal, requestOriginOf(event))` — naming *which* clinician acted — replacing the one shared `{ subjectId: 'admin-token', role: 'admin-token' }` actor every one of these files used.
- **`services/api/src/audit-read-handler.ts`** — `resolvePrincipal` now wraps `request-principal.ts`'s `optionalPrincipal(event)` instead of verifying a bearer token against a resolved SSM secret. `audit-read.ts` itself is unchanged — it asks `can()` about a `Principal` and never knew where it came from, exactly as its own header predicted when TASK 2.1.3 built it.
- **`services/api/src/authz-matrix.ts`, `docs/plan/04-data-model-rbac.md`, `services/api/src/authz.test.ts`** — the three new rows above, transcribed doc-first per `authz-matrix.ts`'s own standing instruction.
- **`services/api/src/audit.ts`** — `AuditActorRole` narrows from `Role | 'admin-token' | 'public' | 'system'` to `Role | 'public' | 'system'`. No code path can construct an `'admin-token'` actor any more; historical rows written under it are real, permanent data (audit rows are append-only, never amended) that this type no longer describes — nothing validates a row read back from storage against `AuditActorRole` (`dynamo-audit-log.ts` trusts the read), so an old row reads back exactly as written.
- **`services/api/src/admin-auth.ts`, `admin-auth.test.ts`, `admin-token.ts`** — deleted. Deleting *code* is not what C-03 prohibits; leaving a live shared-secret path in the tree "in case" would be the actual violation of this task's own intent.
- **`infra/src/route-protection.ts`** — `ADMIN_TOKEN_ROUTE` and `ADMIN_TOKEN_ROUTE_KEYS` deleted entirely (nothing uses them once the migration lands); `GET /testimonials` added to `PUBLIC_ROUTE_KEYS`, reflecting what was already true of its behaviour.
- **`infra/src/data-stack.ts`** — `authorizer: ADMIN_TOKEN_ROUTE` removed from all thirteen routes it previously named (falling to `defaultAuthorizer`); `GET /testimonials/pending` added; `ADMIN_TOKEN_PARAMETER_NAME` env var and the four `ReadAdminApiToken` IAM statements removed from `ContentAuthoringFunction`, `TestimonialModerationFunction`, `WorkshopAuthoringFunction`, `AuditReadFunction`.
- **`infra/src/web-stack.ts`** — `MediaUploadFunction`'s block gated on `props.authorizerFunction`, per the correctness fix above; its own `ReadAdminApiToken` statement and env var removed.
- **`infra/src/config.ts`** — `ADMIN_API_TOKEN_PARAMETER_NAME` export deleted (dead once nothing reads it); `TURNSTILE_SECRET_PARAMETER_NAME`'s own comment, which cited it as the example SecureString convention, repointed to `CERTIFICATE_ARN`.
- **`services/api/src/contact-form-handler.ts`, `stripe-webhook-handler.ts`** — the two comment-only mentions of the retired constant/pattern, corrected to reference conventions that still exist (`stripe-webhook-handler.ts`'s own secret resolution; `registration-handler.ts`'s Turnstile-secret caching).
- **`tests/src/no-admin-token-references.test.ts`** (new) — the Tests line's own "grep finds no reference… a build-level assertion," as a real `git grep`-backed vitest test rather than a description of a check that ran once by hand. Deliberately narrower than a bare substring match on `ADMIN_API_TOKEN`/`admin-auth`: this repo's convention is to document a retirement in the comment at the call site it retired (`audit.ts`, `jwt-verify.ts` both correctly say admin-auth.ts *used to* exist), and banning every prose mention would force deleting exactly the history a reviewer most wants. What it asserts is zero *live code* — an import of the deleted modules, a construct or export that resolved the secret, or a route still opting out through the deleted authorizer.
- **`docs/runbooks/content-authoring.md`, `testimonials.md`, `workshops.md`, `audit-log.md`, `lambda-authorizer.md`, `clinician-accounts.md`, `contact-form.md`** — updated so the documented procedure is the real one (task step 6), each with a superseded-note pointing here rather than a silent rewrite of their own history.

## Verification

- `authz.test.ts` — the three new rows covered by the exhaustive generated suite (5 columns × 3 actions each); the "unassigned sub-clinician is always denied" test's premise correctly excludes them, with the reasoning stated inline.
- `content-authoring.test.ts`, `workshop-authoring.test.ts`, `testimonial-moderation.test.ts`, `media-upload.test.ts` — rewritten from token-based to principal-based fixtures: 401 with no verified principal, 403 for a patient principal, 2xx for a sub-clinician *and* for the principal clinician (the "any clinician" grant, asserted positively, not just left untested). `testimonial-moderation.test.ts` additionally proves the split: `GET /testimonials` unauthenticated with no flag required; `GET /testimonials/pending` flag-gated, 401/403/200 against a principal exactly like the other three files.
- `audit-read.test.ts` — unchanged, 12 tests still pass without modification, proving the "only `resolvePrincipal` changes" design held.
- `audit.test.ts` — the `AuditActorRole` enumeration test updated to the narrowed two-member set.
- `infra/data-stack.test.ts` — all four functions' routes assert `AuthorizationType: 'CUSTOM'`; the SSM-scoping test for content authoring is replaced with a `sids.not.toContain('ReadAdminApiToken')` assertion (the blanket "never grants `ssm:GetParameter`" version was wrong — `grantFlagReads` legitimately grants it, scoped to `/ndn/flags/*`, for an unrelated reason); the route-protection test's `CUSTOM` list grows from 7 to 19, named as one flat sorted array rather than left to drift.
- `infra/web-stack.test.ts` — `synthWithTable()` now actually wires `authorizerFunction` through (a pre-existing gap, fixed here because this task's own `if (props.authorizerFunction)` change is the first thing that depended on it being real); asserts the media-upload route is `CUSTOM` when an authorizer is present and **absent entirely** — no function, no route — when it is not.
- `infra/log-retention.test.ts` — the production-app helper gets the same `authorizerFunction` fix, restoring `/ndn/media-upload-function` to the exhaustive "every `/ndn/*` log group is accounted for" list.
- `tests/src/no-admin-token-references.test.ts` — the repo-wide grep, green.
- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green (infra 189, services/api 898, apps/web 66, tests 1, standalone; one transient CDK-bundling timeout observed under full-monorepo parallel load, non-reproducing on a clean standalone run — the same documented flakiness pattern earlier tasks in this stack hit). `npx markdownlint-cli2` clean on every touched doc. `node scripts/check-no-disable-comments.mjs` clean.

## What was deliberately not built here

- **No new RBAC row for `GET /audit`.** It already had one — `authz-matrix.ts`'s existing `'Audit log'` row, `Principal: R` only — and `audit-read.ts` already called `can()` against it since TASK 2.1.3. Only the principal *source* changed.
- **No sub-clinician-scoped variant of any of the three new resources.** Nothing in this task's Files or Interfaces describes one, and the "any clinician" grant (both `Sub-clinician` columns) makes a scoped variant moot in the one sense that would matter: there is no narrower clinician-facing view to build.
- **No change to `testimonial-submission.ts`, `content-repository.ts`'s public read path, or `workshop-repository.ts`'s public read path.** Those were never behind the admin token and this task's Files line never named them.
- **No attempt to keep `GET /testimonials/pending`'s addition inside the task's literal "same routes" line.** Documented above as a necessary, load-bearing deviation rather than silently shipped — the alternative (leaving the queue unreachable, or the public read broken) is strictly worse than a one-route interface change.

## Rollback

Revert the branch. The bearer gate returns — but the SSM parameter `/ndn/admin-api-token` must **not** be deleted until this deploy is verified in production; that ordering is the rollback plan (step 5), not a separate safeguard. There is no flag: two authentication mechanisms behind a flag would leave the weaker one reachable, so this is a cutover deploy, sized deliberately small enough to revert outright.

## Cost

£0.00 — removes one SSM parameter (once deleted by hand, post-verification) and four IAM grants. No new resource of any kind.
