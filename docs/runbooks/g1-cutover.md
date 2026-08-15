# G1 cutover — apex/www DNS, legacy Lambda decommission (TASK 1.6.1)

**Date started:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.6.1](../plan/05-execution-plan.md) · **Decisions:** D-02, D-08, D-25 · **Risks:** R-06 · **Depends on:** 0.0.2, 1.1.1–1.5.2

**Status: certificate issued, CloudFront alias step FAILED and rolled back, DNS cutover not yet executed.** This is the highest-risk task in the plan — it repoints the live `nourishthenerve.com` apex/`www` off the legacy site and, after an observation window, irreversibly deletes the legacy Lambda. Per the task's own step ordering, the DNS cutover (step 4 below) and the Lambda decommission (step 7) are **explicitly held for the site owner's go-ahead**, not executed as part of this prep pass.

**2026-08-15 correction:** the PR #38 merge's `deploy` job (CI run [31845241373](https://github.com/nourishthenerve/ndn-monolithic/actions/runs/31845241373)) **failed**, not succeeded as this doc previously claimed. `NdnWebStack` is confirmed `UPDATE_ROLLBACK_COMPLETE` — live and serving `next.` exactly as before, no lasting effect — but the apex/`www` aliases were never actually added. See "CloudFront alternate domain names (step 3)" below for what broke and why it changes the plan for step 4.

## Pre-flight (step 1) — confirmed 2026-08-14

Every Phase 1 task (1.1.1–1.5.2) is deployed and green at `next.nourishthenerve.com`:

- CI run [31837112292](https://github.com/nourishthenerve/ndn-monolithic/actions/runs/31837112292) (PR #37 / TASK 1.5.2 merge) completed, `deploy` job green.
- `GET /health` → `{"status":"ok","version":"d87502749c6dda4edff81c47c6327013c5dbb22a", ...}` — matches `main`'s current HEAD (`d875027`).
- Smoke-checked `/en`, `/en/blog`, `/en/workshops`, `/en/contact`, `/en/legal/privacy`, `/en/legal/cookies`, `/en/legal/terms`, `/en/legal/accessibility-statement` — all `200`.

A11y (1.1.3) and Core Web Vitals checks against the live apex specifically happen after cutover (step 5/9 below), per the task's own "regression... only surfaces now" note — `next.` has carried the a11y CI gate on every PR already.

## Certificate (step 2) — issued 2026-08-14

ACM certs are immutable — SANs can't be added to the existing `next.`-only certificate from TASK 0.4.1, so a new one was requested covering all three hostnames in one cert (CloudFront allows only one certificate per distribution):

```bash
aws --profile ndn-prod acm request-certificate \
  --domain-name nourishthenerve.com \
  --subject-alternative-names www.nourishthenerve.com next.nourishthenerve.com \
  --validation-method DNS --region us-east-1
# -> arn:aws:acm:us-east-1:357601815388:certificate/c7f37883-1f9e-4abc-94b3-18fb028cf9e2
```

Three DNS validation CNAMEs, all in the `nourishthenerve.com` zone (`803129122420`, `default` profile — same cross-account manual step 0.4.1 used):

| Hostname | Record | Value |
|---|---|---|
| `nourishthenerve.com` | `_c95428975227e64a30971834b6277a8e.nourishthenerve.com.` | `_6f5fdab6944fbcf32a2b5d25519c741b.jkddzztszm.acm-validations.aws.` |
| `www.nourishthenerve.com` | `_9fed88c14eacb263e2dfc68235d697b6.www.nourishthenerve.com.` | `_3d4f7841df782175790c4bc81e9029e7.jkddzztszm.acm-validations.aws.` |
| `next.nourishthenerve.com` | `_429359320b68325a7587cc168adc3028.next.nourishthenerve.com.` | `_3ba941437d40be275493a8210a4bef5c.jkddzztszm.acm-validations.aws.` |

The `next.` row is byte-for-byte identical to the CNAME TASK 0.4.1 already added — ACM reuses the same challenge token for a domain it has already validated once, so only the apex and `www` rows were new. Added via `route53 change-resource-record-sets` (`UPSERT`, additive, apex/`www`'s own A/CNAME records untouched). `describe-certificate` → `Status: ISSUED` within ~25s of adding the two new records.

The TASK 0.4.1 certificate (`arn:.../b1f9e01e-ab10-43b8-944a-6c0ccfffacb5`) is left in place, unused — free, harmless, matching that task's own rollback note.

## CloudFront alternate domain names (step 3) — code merged, deploy FAILED, rolled back cleanly

`infra/src/config.ts` gained `APEX_DOMAIN_NAME`/`WWW_DOMAIN_NAME`; `CERTIFICATE_ARN` now points at the new three-SAN cert. `infra/src/web-stack.ts`'s `domainNames` is now `[DOMAIN_NAME, APEX_DOMAIN_NAME, WWW_DOMAIN_NAME]` on the **existing** `NdnWebStack` distribution (`dbn8dfhgi712k.cloudfront.net`) — no second distribution, reuses the already-proven canary/rollback/security-headers/OAC shape per the task's own instruction. `infra/src/web-stack.test.ts` was updated to assert all three aliases in both the production-mode test and the "production mode is unaffected" ephemeral-comparison test. This part is fine and stays merged.

**What was wrong: this step was assumed to be additive and DNS-invisible on its own. It is not.** CI run [31845241373](https://github.com/nourishthenerve/ndn-monolithic/actions/runs/31845241373) (the PR #38 merge's `deploy` job) failed:

```
NdnWebStack/Distribution: UPDATE_FAILED — Invalid request provided: One or more aliases
specified for the distribution includes an incorrectly configured DNS record that points
to another CloudFront distribution. (Service: CloudFront, Status Code: 409, HandlerErrorCode: InvalidRequest)
```

CloudFront performs a live DNS lookup on every alias you try to add and **refuses the change if that hostname's DNS currently resolves to a *different* CloudFront distribution** (an anti-hijack/domain-ownership check — see AWS's CloudFront alternate-domain-name restrictions doc). `nourishthenerve.com`/`www.nourishthenerve.com` still point at the legacy distribution `d2z3fclxq13w3z.cloudfront.net`, which — being CloudFront too — trips this check. CloudFormation rolled the stack back cleanly: confirmed `NdnWebStack` is `UPDATE_ROLLBACK_COMPLETE` and `next.nourishthenerve.com` is the distribution's only live alias, exactly as before this PR. No production impact occurred.

**Consequence for the plan:** steps 3 and 4 cannot run in the order the task text describes (alias added first, invisibly, DNS moved second). The alias can only be added successfully *after* DNS already points at `NdnWebStack`, which means there is necessarily a window — bounded by how long the `cdk deploy` of the alias addition takes, roughly 1–2 minutes going by this run's timings from changeset start to distribution `UPDATE_COMPLETE` — during which apex/`www` DNS points at `NdnWebStack` but `NdnWebStack` does not yet recognize that `Host`, and CloudFront serves those requests an error page instead of the site. This is a **real, if short, downtime window that the original task text did not account for**, and it is in tension with this project's zero-downtime constraint. It needs an explicit decision before step 4 runs — see the site owner's go-ahead note under step 4 below, which now covers this too, not only the DNS record change itself.

**Revised step 3, to run immediately before/alongside step 4 rather than in advance of it:** re-run `cdk deploy` (or merge a no-op PR that re-triggers it) for the alias addition *right after* the DNS records are repointed in step 4, not before. Until then this step is **not done** — the live distribution has only the `next.` alias.

## TTL lowered ahead of cutover (part of step 4's prep) — done 2026-08-14

`www.nourishthenerve.com`'s CNAME TTL was `500`; lowered to `60` (target unchanged — still `d2z3fclxq13w3z.cloudfront.net`, zero traffic impact) so that if the real cutover needs a fast rollback, resolvers pick up the reverted record quickly. The apex record is a Route 53 **ALIAS**, which has no TTL of its own and resolves through Route 53 directly — already fast. **Wait at least the old TTL (500s, call it 15+ minutes for safety against caching resolvers that ignore TTL) after this change before running the actual cutover**, so caches have already rolled onto the new 60s TTL by the time it matters.

## Remaining steps — NOT executed, awaiting the site owner's go-ahead

### Step 4: DNS cutover + re-deploy the CloudFront alias, back to back (real production traffic impact, includes a short error-page window)

**Revised from the original task text** (see step 3 above): because CloudFront refuses to add an alias while DNS still points at a different CloudFront distribution, the alias cannot be pre-staged invisibly. The two changes now have to happen in immediate succession:

1. In the `803129122420` zone (manual, `default` profile — `ndn-deploy` has no access there):
   ```bash
   # Apex: change the ALIAS target from d2z3fclxq13w3z.cloudfront.net to dbn8dfhgi712k.cloudfront.net
   # www: change the CNAME target the same way (TTL already lowered to 60 above)
   ```
2. Immediately trigger the `NdnWebStack` deploy that adds `APEX_DOMAIN_NAME`/`WWW_DOMAIN_NAME` to `domainNames` (the code from step 3 is already merged — this is a re-run, e.g. re-dispatch the `deploy` job or push a no-op commit).

Between (1) and (2) completing, requests to `nourishthenerve.com`/`www.nourishthenerve.com` will resolve to `NdnWebStack` but get a CloudFront error page (Host not yet a recognized alias) instead of either site — an error window of roughly 1–2 minutes based on the failed run's changeset-to-`UPDATE_COMPLETE` timing, not the zero-downtime, fully-invisible cutover the task text originally described. **This is a materially different risk profile than what was documented and needs its own explicit sign-off, separate from the general "confirm before running step 4" instruction below** — see `docs/plan/05-execution-plan.md`'s own framing of this as the plan's highest-risk task.

**Do not run this without explicit confirmation from the site owner in the same session it runs.**

### Step 5: Verify immediately after cutover

```bash
curl -sI https://nourishthenerve.com/    # expect 200 (or 302 -> /en), full security-header set
curl -sI https://www.nourishthenerve.com/
curl -s  https://nourishthenerve.com/health
```

Watch the TASK 0.6.2 canary/auto-rollback machinery on this deploy specifically — its first time serving the apex. Also the moment to update two hardcoded staging-URL fallbacks that were deliberately **not** touched during prep (changing them earlier would have made `next.` emit apex URLs before the apex served anything):

- `apps/web/src/site-config.ts`'s `siteUrl` → `https://nourishthenerve.com` (canonical/hreflang URLs).
- `services/api/src/stripe-checkout-handler.ts`'s `SITE_ORIGIN` fallback → same. (Currently unwired as a CDK env var — either wire `SITE_ORIGIN` in `data-stack.ts`'s `WorkshopCheckoutFunction` or edit the fallback directly; `payments.stripeCheckout.enabled` is off by default regardless, gated on LL-03.)

### Step 6: Observe 24–48h before touching the legacy Lambda

Monitor `nourishthenerve-api`'s CloudWatch invocation metrics in `803129122420` to confirm invocations drop to zero (excluding this task's own verification probes):

```bash
aws --profile default --region eu-west-2 cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions Name=FunctionName,Value=nourishthenerve-api \
  --start-time <cutover-time> --end-time <now> --period 3600 --statistics Sum
```

### Step 7: Decommission the legacy Lambda — irreversible, `803129122420` only

**Requires explicit go-ahead after the observation window — this cannot be undone.**

```bash
aws --profile default --region eu-west-2 lambda delete-function-url-config --function-name nourishthenerve-api
aws --profile default --region eu-west-2 lambda delete-function --function-name nourishthenerve-api
```

Leaves the S3 bucket `nourishthenerve` exactly as TASK 0.0.2 configured it — versioned, read-only, `clients/`/`posts/` untouched (D-03 forbids deleting it, this task included). Deleting the Lambda also resolves the two pre-existing legacy issues `legacy-estate.md` flagged (unauthenticated `/client/{id}/report` enumeration, broken `/form` route) by removing the surface entirely — if step 7 is delayed past this task's completion for any reason, that exposure remains live and should be re-flagged, not silently carried forward again.

### Step 8: Update the cost model reconciliation

`docs/plan/03-cost-model.md`'s M1 line items were all modelled pre-traffic; once real apex traffic is being served, re-check actual vs modelled spend (Route 53 queries, CloudFront requests, Lambda invocations at real visitor volume) and record it there per Gate G1's checklist.

## Verification (final, once steps 4–8 all run)

- `dig nourishthenerve.com` / `dig www.nourishthenerve.com` resolve to `NdnWebStack`'s distribution.
- `curl -sI` both return `200` with the full security-header set (HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options`, Referrer-Policy — same assertions `iac-baseline.md` ran against `next.`).
- A Core Web Vitals run against the live apex passes Gate G1's bar.
- `aws lambda get-function --function-name nourishthenerve-api` → `ResourceNotFoundException`.
- The S3 bucket `nourishthenerve`'s objects remain read-only accessible exactly as TASK 0.0.2 left them.

## Rollback

- **Before step 7 (Lambda deletion):** DNS-only. Revert the apex ALIAS and `www` CNAME in `803129122420` back to `d2z3fclxq13w3z.cloudfront.net` — restores the legacy experience with zero AWS resource changes. `www`'s 60s TTL means this propagates within roughly a minute for most resolvers.
- **After step 7:** the Lambda cannot be undeleted. A post-step-7 issue is fixed forward on the new stack, or rolled back via the same DNS revert above (the legacy CloudFront distribution itself is never touched by this task, so it keeps serving whatever it was serving — static assets only, since the Lambda behind its API calls would now be gone). This is exactly why the observation window and step ordering exist.
- **Certificate (step 2):** harmless to leave in place even if the DNS cutover is never run — an unused-but-valid ACM cert costs nothing and exposes nothing new.
- **CloudFront alternate domain names (step 3):** not currently deployed (see above) — the merged code is a no-op until re-run alongside step 4, so there is nothing here to roll back.

## Do NOT

- Touch anything in the unidentified third account currently serving the legacy CloudFront distribution (`d2z3fclxq13w3z.cloudfront.net`) — this task can only ever repoint DNS away from it, never modify it.
- Delete, empty, or version-purge the S3 bucket `nourishthenerve` or its prefixes, under any circumstance (D-03).
- Run step 7 before the full observation window and explicit owner go-ahead.
- Run step 4 without explicit, same-session confirmation from the site owner.
