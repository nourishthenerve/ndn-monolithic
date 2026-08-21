# G1 cutover — apex/www DNS, legacy Lambda decommission (TASK 1.6.1)

**Date started:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.6.1](../plan/05-execution-plan.md) · **Decisions:** D-02, D-08, D-25 · **Risks:** R-06 · **Depends on:** 0.0.2, 1.1.1–1.5.2

**Status: BLOCKED, awaiting an AWS Support case. The CloudFront alias cannot be added while the legacy distribution — in an AWS account we have no access to — still holds it. A same-session, owner-approved cutover attempt on 2026-08-15 confirmed this the hard way (see "2026-08-15 cutover attempt" below) and was reverted within ~90 seconds. The owning account has since been searched for and definitively ruled out of our reach ("Ownership search"), and both prerequisites for AWS's documented cross-account domain-move process are now in place ("Support-case prerequisites"). The case is **filed** (owner, confirmed 2026-08-21) and awaiting an AWS reply; the task is parked on the owner's decision until that lands, and Phase 2 proceeds around it. Next action: poll `list-conflicting-aliases` for `Quantity: 0` — see "Conflicting-alias check" below, which also records that the conflicting distribution's owning account ends `155257`, a lead worth putting to the owner in parallel. Re-verified unchanged 2026-08-21. Do not retry step 4 until the aliases are actually released.**

This is the highest-risk task in the plan — it repoints the live `nourishthenerve.com` apex/`www` off the legacy site and, after an observation window, irreversibly deletes the legacy Lambda. Per the task's own step ordering, the DNS cutover (step 4 below) and the Lambda decommission (step 7) were always meant to be **explicitly held for the site owner's go-ahead**, not executed as part of any prep pass — that gate did its job: the owner approved a same-session attempt on 2026-08-15, it hit a real blocker, and was rolled back immediately per the pre-agreed rollback procedure.

**2026-08-15 correction (superseded by the cutover attempt below, kept for history):** the PR #38 merge's `deploy` job (CI run [31845241373](https://github.com/nourishthenerve/ndn-monolithic/actions/runs/31845241373)) **failed**, not succeeded as this doc previously claimed. `NdnWebStack` rolled back cleanly, no apex/`www` aliases were added. See "CloudFront alternate domain names (step 3)" below for the first failure mode, and "2026-08-15 cutover attempt" for the second, harder one found when step 4 was actually attempted.

## 2026-08-15 cutover attempt — blocked, reverted

With explicit owner go-ahead in-session, the revised step 4 (DNS first, alias re-deploy immediately after — see below) was attempted:

1. **10:17:35 UTC** — apex `A`/ALIAS and `www` CNAME repointed from `d2z3fclxq13w3z.cloudfront.net` to `dbn8dfhgi712k.cloudfront.net` (`NdnWebStack`) in the `803129122420` zone.
2. **10:17:35 UTC** — `cdk deploy NdnWebStack` triggered immediately after, to add the apex/`www` aliases to `NdnWebStack` and pick up the three-SAN certificate.
3. **10:18:06 UTC** — deploy failed, a **different** error than the earlier CI failure:

   ```text
   NdnWebStack/Distribution: UPDATE_FAILED — Invalid request provided: One or more of the
   CNAMEs you provided are already associated with a different resource.
   (Service: CloudFront, Status Code: 409, HandlerErrorCode: InvalidRequest)
   ```

   CloudFormation rolled `NdnWebStack` back automatically (`UPDATE_ROLLBACK_COMPLETE` by 10:18:20 UTC).
4. **10:18:47 UTC** — apex/`www` DNS reverted back to `d2z3fclxq13w3z.cloudfront.net`, restoring the legacy site. Confirmed via `dig`/`curl`: apex `302` → `www`, `www` `200`, both served by the legacy distribution again.

**Total window where apex/`www` served a CloudFront error page instead of either site: ~72 seconds (10:17:35–10:18:47 UTC).**

**Why this is a different, harder problem than the step-3 failure:** the step-3 failure was a *DNS-based* pre-check ("does this alias's DNS currently point elsewhere") that a DNS-first ordering was expected to satisfy. This one is CloudFront's actual **alias-uniqueness constraint**: an alternate domain name can only be attached to *one* CloudFront distribution at a time, globally, across every AWS account — and it is enforced against the distribution's own configuration, not DNS. The legacy distribution `d2z3fclxq13w3z.cloudfront.net` still has `nourishthenerve.com`/`www.nourishthenerve.com` configured as *its* aliases. Repointing DNS doesn't release that claim — only removing the alias from the legacy distribution's own configuration does, and that distribution lives in the unidentified third AWS account this project has never held credentials for (see 00-index.md's "Verified position"). There is no DNS trick, deploy-ordering trick, or retry that gets around this from our side alone.

**Path forward — needs one of, before step 4 can be retried:**

1. **Identify and get cooperation from whoever controls the account serving `d2z3fclxq13w3z.cloudfront.net`**, so they (or we, with temporary access) remove `nourishthenerve.com`/`www.nourishthenerve.com` from that distribution's aliases — after which `NdnWebStack` can claim them immediately (`cdk deploy` would then succeed the same way it does for any fresh alias). **Ruled out 2026-08-15 — see "Ownership search" below.**
2. **An AWS Support case**, if (1) isn't possible — AWS has a documented process for moving an alternate domain name to a distribution in a different account when you can demonstrate you own the domain (you control its Route 53 zone, which we do). This is the standard remediation AWS points to for exactly this cross-account CNAME conflict; see AWS's "resolve the CNAMEAlreadyExists error" and "move an alternate domain name" guidance. **This is now the active path — prerequisites completed 2026-08-15, see below.**
3. Either way, this is a **prerequisite investigation/coordination task, not a retry of step 4** — repeating the same DNS-then-deploy sequence will fail identically every time until the alias is actually released on the legacy side.

## Ownership search — exhausted 2026-08-15

The site owner recalled building the original `nourishthenerve.com` themselves under `803129122420`, which would have made this a same-account move (`update-domain-association`, no Support needed). Checked directly, as root on that account — it does **not** hold the legacy distribution:

- `aws cloudfront list-distributions` (as `arn:aws:iam::803129122420:root`) returns exactly **4** distributions, all `islamicmaps.org` (`app`/`landing`/`api`/`cdn`). No `d2z3fclxq13w3z`, no `nourishthenerve.com` alias on any of them. CloudFront is a global service — `--region` does not scope this listing, so this is the account's complete inventory.
- `aws organizations list-accounts` — `803129122420` is the management account of org `o-tsnehqxpmj`, whose only members are itself and `357601815388` (`ndn-prod`, created for this project). There is no forgotten sibling account to check.

So the legacy distribution is confirmed to sit in an AWS account nobody on this project can currently sign into, and option 1 is closed unless that account is later identified. **Do not spend more time searching for it** — option 2 does not require knowing whose it is.

## Support-case prerequisites — completed 2026-08-15

AWS's cross-account alternate-domain-name move has two prerequisites that must be in place *before* the case is filed, or it bounces back. Both are now done. Neither moves traffic.

### 1. Domain-control validation TXT records — added

AWS validates domain ownership via a TXT record per hostname, named with a leading `_` (`_.` for an apex), valued with the **target** distribution's domain name:

| Record | Value |
|---|---|
| `_.nourishthenerve.com` | `dbn8dfhgi712k.cloudfront.net` |
| `_www.nourishthenerve.com` | `dbn8dfhgi712k.cloudfront.net` |

Added by `route53 change-resource-record-sets` (`UPSERT`, TTL 300) in the `803129122420` zone, `default` profile — same cross-account manual step 0.4.1 and step 2 used. Purely additive: both are new record *names*, so the apex `A`/ALIAS, `www` `CNAME`, and the Zoho MX/SPF/DKIM/DMARC records were all untouched. Verified resolving via `dig +short TXT _.nourishthenerve.com @8.8.8.8`.

### 2. Certificate attached to the target distribution — decoupled from the alias addition

**The 2026-08-15 deploy failure hid a second problem:** that deploy changed *two* things at once — swapped `CERTIFICATE_ARN` to the three-SAN cert **and** added the apex/`www` aliases. Only the alias addition is blocked by the CNAME conflict, but CloudFormation rolls back the whole update, so **the certificate never landed either**. The repo said three-SAN cert + 3 aliases; the live distribution had the old `next.`-only cert + 1 alias. That drift went unrecorded until now.

It matters because "target distribution carries a certificate covering the domain" is itself an AWS prerequisite for the move — the case cannot proceed without it, and `aws cloudfront list-conflicting-aliases` (which reports the masked owning account ID) refuses to run without it too.

Fixed by decoupling: `web-stack.ts`'s `domainNames` is back to `[DOMAIN_NAME]` while `CERTIFICATE_ARN` stays on the three-SAN cert `c7f37883-1f9e-4abc-94b3-18fb028cf9e2`. Synth confirms `Aliases: ['next.nourishthenerve.com']` with that cert attached. A regression test (`attaches the apex/www-covering certificate without yet claiming those aliases`) asserts the two stay decoupled, so a future edit can't re-bundle them and reproduce the failure. `APEX_DOMAIN_NAME`/`WWW_DOMAIN_NAME` rejoin `domainNames` only *after* Support completes the move.

**Support plan caveat:** both accounts are on Basic support (`describe-severity-levels` → `SubscriptionRequiredException` on each). Technical cases normally require Business tier or above; cases like this are usually accepted under **Account and Billing** (free on Basic), but routing may need adjusting if it is rejected as technical.

The case text to file is in [g1-cutover-support-case.md](g1-cutover-support-case.md).

## Conflicting-alias check — run 2026-08-21, source account narrowed

With the three-SAN certificate attached, `list-conflicting-aliases` finally runs (it refused while the distribution carried only the `next.`-only cert). Run from `ndn-prod` for both hostnames:

```bash
aws --profile ndn-prod cloudfront list-conflicting-aliases \
  --alias nourishthenerve.com --distribution-id E1K6OYW4X46BJZ
aws --profile ndn-prod cloudfront list-conflicting-aliases \
  --alias www.nourishthenerve.com --distribution-id E1K6OYW4X46BJZ
```

Each returns exactly one conflict, and it is the **same** distribution for both:

| Alias | Conflicting distribution | Owning account |
|---|---|---|
| `nourishthenerve.com` | `*******0TMKEWA` | `******155257` |
| `www.nourishthenerve.com` | `*******0TMKEWA` | `******155257` |

AWS masks all but the trailing characters by design. Two things follow.

**The conflict is live and unchanged** — nothing has quietly released the aliases since 2026-08-15. This command is also the cheapest way to detect when AWS *has* completed the move: `Quantity: 0` means released. Re-run it rather than retrying a deploy to find out.

**The owning account ends `155257`** — neither `803129122420` nor `357601815388`. That independently confirms the "Ownership search" conclusion above, and it is something the 2026-08-15 search never had: a concrete identifier the site owner may recognise (an old personal account, a former agency's, a previous developer's). **If it is recognised and still accessible, "Path forward" option 1 reopens and the Support case becomes unnecessary** — removing the two aliases from that distribution's own configuration lets `NdnWebStack` claim them on the next ordinary deploy, with no queue and no SLA to wait on. This is the one question worth putting to the owner before the case is filed; it is not a reason to resume searching AWS-side, which remains closed.

Strictly, the masked ID cannot be compared against a domain name, so this does not *prove* the conflicting distribution is `d2z3fclxq13w3z.cloudfront.net` — only that a single distribution outside both of our accounts holds both names. Live DNS points apex/`www` at `d2z3fclxq13w3z.cloudfront.net` and that distribution serves them, so in practice they are the same thing.

## Status re-verified 2026-08-21

Nothing has changed and nothing has drifted. Support case **filed by the site owner, no reply yet** — filing was necessarily a console action for them, since both accounts are Basic and `support create-case` is unavailable to this project (`SubscriptionRequiredException`), which also means this repo cannot read the case's status or AWS's response. Progress is visible here only as `list-conflicting-aliases` dropping to `Quantity: 0`.

**Owner decision, 2026-08-21:** park the cutover until AWS acts rather than hold Phase 2 behind it. Gate G1 is recorded as not-met on the apex criterion for exactly this reason — see `docs/plan/gate-g1-report.md`, added on its own branch.

| Check | Result |
|---|---|
| `dig +short TXT _.nourishthenerve.com` / `_www.` | both `"dbn8dfhgi712k.cloudfront.net"` — prerequisites intact |
| apex `curl -sI` | `302` → `www`, served by the legacy distribution |
| `www` `curl -sI` | `200`, `server: AmazonS3` via the legacy distribution |
| `www` CNAME | `d2z3fclxq13w3z.cloudfront.net` (unchanged; TTL still 60) |
| `NdnWebStack` distribution | `Deployed`, aliases `['next.nourishthenerve.com']`, three-SAN cert `c7f37883…` attached — decoupling holds |
| `next.nourishthenerve.com/health` | `200`, version `4c7dedf` (`main`'s last code-bearing commit; `d64a5b1` was docs + AWS-side only) |
| Alias conflict | still held — see the table above |

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

```text
NdnWebStack/Distribution: UPDATE_FAILED — Invalid request provided: One or more aliases
specified for the distribution includes an incorrectly configured DNS record that points
to another CloudFront distribution. (Service: CloudFront, Status Code: 409, HandlerErrorCode: InvalidRequest)
```

CloudFront performs a live DNS lookup on every alias you try to add and **refuses the change if that hostname's DNS currently resolves to a *different* CloudFront distribution** (an anti-hijack/domain-ownership check — see AWS's CloudFront alternate-domain-name restrictions doc). `nourishthenerve.com`/`www.nourishthenerve.com` still point at the legacy distribution `d2z3fclxq13w3z.cloudfront.net`, which — being CloudFront too — trips this check. CloudFormation rolled the stack back cleanly: confirmed `NdnWebStack` is `UPDATE_ROLLBACK_COMPLETE` and `next.nourishthenerve.com` is the distribution's only live alias, exactly as before this PR. No production impact occurred.

**Consequence for the plan:** steps 3 and 4 cannot run in the order the task text describes (alias added first, invisibly, DNS moved second). The alias can only be added successfully *after* DNS already points at `NdnWebStack`, which means there is necessarily a window — bounded by how long the `cdk deploy` of the alias addition takes, roughly 1–2 minutes going by this run's timings from changeset start to distribution `UPDATE_COMPLETE` — during which apex/`www` DNS points at `NdnWebStack` but `NdnWebStack` does not yet recognize that `Host`, and CloudFront serves those requests an error page instead of the site. This is a **real, if short, downtime window that the original task text did not account for**, and it is in tension with this project's zero-downtime constraint. It needs an explicit decision before step 4 runs — see the site owner's go-ahead note under step 4 below, which now covers this too, not only the DNS record change itself.

**Revised step 3, superseded 2026-08-15 by the Support-case path:** the earlier revision here said to re-run the alias-addition deploy immediately *after* the step-4 DNS repoint. That was tried and failed on the alias-uniqueness constraint (see "2026-08-15 cutover attempt"). The alias cannot be added by any ordering until AWS releases it from the legacy distribution. What *has* now landed from this step is the certificate half only — see "Support-case prerequisites" above. The live distribution still has just the `next.` alias, and correctly so.

## TTL lowered ahead of cutover (part of step 4's prep) — done 2026-08-14

`www.nourishthenerve.com`'s CNAME TTL was `500`; lowered to `60` (target unchanged — still `d2z3fclxq13w3z.cloudfront.net`, zero traffic impact) so that if the real cutover needs a fast rollback, resolvers pick up the reverted record quickly. The apex record is a Route 53 **ALIAS**, which has no TTL of its own and resolves through Route 53 directly — already fast. **Wait at least the old TTL (500s, call it 15+ minutes for safety against caching resolvers that ignore TTL) after this change before running the actual cutover**, so caches have already rolled onto the new 60s TTL by the time it matters.

## Remaining steps — BLOCKED on the third-account alias conflict, not merely "awaiting go-ahead"

### Step 4: DNS cutover + re-deploy the CloudFront alias, back to back — attempted 2026-08-15, blocked, reverted

See "2026-08-15 cutover attempt" above for what was tried, the exact failure, and the revert. The procedure below is kept as the accurate record of what was executed (and what will need to run again once the alias conflict is resolved), not as a next action to take as-is.

1. In the `803129122420` zone (manual, `default` profile — `ndn-deploy` has no access there):

   ```bash
   # Apex: change the ALIAS target from d2z3fclxq13w3z.cloudfront.net to dbn8dfhgi712k.cloudfront.net
   # www: change the CNAME target the same way (TTL already lowered to 60 above)
   ```

2. Immediately trigger the `NdnWebStack` deploy that adds `APEX_DOMAIN_NAME`/`WWW_DOMAIN_NAME` to `domainNames` (the code from step 3 is already merged — this is a re-run, e.g. re-dispatch the `deploy` job or push a no-op commit).

This got past the step-3 DNS pre-check but hit CloudFront's alias-uniqueness constraint instead (see above) — the deploy failed and rolled back, and DNS was reverted immediately after. **Do not re-run this until the "Path forward" items above are resolved** — as executed, it reliably reproduces the same ~70s error-page window and failed deploy, not a working cutover.

### Step 5: Verify immediately after cutover

```bash
curl -sI https://nourishthenerve.com/    # expect 200 (or 302 -> /en), full security-header set
curl -sI https://www.nourishthenerve.com/
curl -s  https://nourishthenerve.com/health
```

Watch the TASK 0.6.2 canary/auto-rollback machinery on this deploy specifically — its first time serving the apex. Also the moment to update two hardcoded staging-URL fallbacks that were deliberately **not** touched during prep (changing them earlier would have made `next.` emit apex URLs before the apex served anything):

- `apps/web/src/site-config.ts`'s `siteUrl` → `https://nourishthenerve.com` (canonical/hreflang URLs).
- `services/api/src/stripe-checkout-handler.ts`'s `SITE_ORIGIN` fallback → same. (Currently unwired as a CDK env var — either wire `SITE_ORIGIN` in `data-stack.ts`'s `WorkshopCheckoutFunction` or edit the fallback directly; `payments.stripeCheckout.enabled` is off by default regardless, gated on LL-03.)

### Steps 6 and 7 — DONE 2026-08-15, ahead of the cutover

**Both steps are complete.** On owner instruction ("all legacy infra except Route 53/DNS"), the Lambda, its Function URL, its log group, and five legacy IAM roles plus six policies were deleted on 2026-08-15 — *before* the DNS cutover rather than after it. Full record, including the traffic evidence and blast-radius check that made running early safe, is in [legacy-estate.md](legacy-estate.md#decommission--executed-2026-08-15-supersedes-the-not-done-list-above).

Consequences for the rest of this runbook:

- **Step 9's exposure warning is discharged** — the unauthenticated `/client/{id}/report` endpoint no longer exists. It is no longer "carried forward" while the cutover waits on AWS.
- **R-06 is closed**, not merely contained.
- **The DoD's Lambda clauses are met** — `aws lambda get-function --function-name nourishthenerve-api` returns `ResourceNotFoundException` today.
- **The S3 bucket `nourishthenerve` remains**, untouched and now unreachable (its only reader is gone). D-03 still forbids deleting it absent an explicit owner override; see legacy-estate.md's "Still outstanding".
- **Nothing about the CloudFront alias conflict changes.** The blocker lives in the third account's distribution config; deleting our Lambda neither helps nor hinders it. The support case stands as filed.

The original step 6/7 text is kept below for the record.

### Step 6 (original): Observe 24–48h before touching the legacy Lambda

Monitor `nourishthenerve-api`'s CloudWatch invocation metrics in `803129122420` to confirm invocations drop to zero (excluding this task's own verification probes):

```bash
aws --profile default --region eu-west-2 cloudwatch get-metric-statistics \
  --namespace AWS/Lambda --metric-name Invocations \
  --dimensions Name=FunctionName,Value=nourishthenerve-api \
  --start-time <cutover-time> --end-time <now> --period 3600 --statistics Sum
```

### Step 7 (original): Decommission the legacy Lambda — irreversible, `803129122420` only

**Executed 2026-08-15 — see "Steps 6 and 7" above. The commands below are the ones that were run.**

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
- `aws lambda get-function --function-name nourishthenerve-api` → `ResourceNotFoundException`. **Already satisfied 2026-08-15.**
- The S3 bucket `nourishthenerve`'s objects remain as TASK 0.0.2 left them. **Still satisfied** — the decommission deleted no objects. Note the bucket is now unreadable by any principal, since the role holding `GetObject` was deleted with the Lambda; "read-only accessible" now means only via the account root/an explicitly granted principal.

## Rollback

- **DNS revert (the only rollback that matters now):** revert the apex ALIAS and `www` CNAME in `803129122420` back to `d2z3fclxq13w3z.cloudfront.net`. `www`'s 60s TTL means this propagates within roughly a minute for most resolvers. **Exercised for real on 2026-08-15** (see "2026-08-15 cutover attempt" above) — confirmed working exactly as documented, reverted and verified within ~90 seconds of the failed deploy. Note that since step 7 ran, this restores the legacy site's *static* content only — its API-backed pages are permanently gone, by design.
- **Step 7 is done and cannot be undone.** The Lambda, its Function URL, its log group and its IAM roles/policies no longer exist. Any future issue is fixed forward on the new stack, never by resurrecting them. The Lambda's source is archived at `~/Desktop/nourishthenerve/legacy-lambda-main.py` if it is ever needed for reference (not redeployment — the role, policy and Function URL are all gone too).
- **Certificate (step 2):** harmless to leave in place even if the DNS cutover is never run — an unused-but-valid ACM cert costs nothing and exposes nothing new.
- **CloudFront alternate domain names (step 3):** the apex/`www` aliases are not deployed and cannot be until AWS completes the domain move, so there is nothing there to roll back. The certificate half *is* deployed (three-SAN cert on `NdnWebStack`'s distribution): to revert, point `CERTIFICATE_ARN` back at `b1f9e01e-ab10-43b8-944a-6c0ccfffacb5` and redeploy — though there is no reason to, since the three-SAN cert covers `next.` identically and is a Support-case prerequisite.
- **Domain-control validation TXT records:** harmless to leave in place indefinitely — they name hostnames (`_.`/`_www.`) nothing resolves for real, and affect no live record. Delete with a `DELETE` change batch on the same two records if ever needed.

## Do NOT

- Touch anything in the unidentified third account currently serving the legacy CloudFront distribution (`d2z3fclxq13w3z.cloudfront.net`) — this task can only ever repoint DNS away from it, never modify it.
- Delete, empty, or version-purge the S3 bucket `nourishthenerve` or its prefixes (D-03) — this survives the 2026-08-15 decommission unchanged. The bucket is now inert and unreachable; removing it needs an explicit owner decision recorded against D-03, not an inference from "remove the legacy estate."
- Run step 4 without explicit, same-session confirmation from the site owner.
- Retry step 4 as-is expecting a different outcome — it is blocked on the alias-uniqueness conflict, not on timing or ordering, and will fail the same way every time until "Path forward" above is actually resolved.
