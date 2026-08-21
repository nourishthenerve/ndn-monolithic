# G1 cutover — apex/www DNS, legacy Lambda decommission (TASK 1.6.1)

**Date started:** 2026-08-14 · **Task:** [05-execution-plan.md § TASK 1.6.1](../plan/05-execution-plan.md) · **Decisions:** D-02, D-08, D-25 · **Risks:** R-06 · **Depends on:** 0.0.2, 1.1.1–1.5.2

**Status: UNBLOCKED 2026-08-21 — no Support case needed, the fix is self-service.** AWS Support's reply identified the holder of the apex/`www` aliases: not an unreachable third account, but the **`ndn-frontend` Amplify app in `803129122420`**, an account we have root on. Verified independently (see "Holder identified" below). Releasing the aliases is one `amplify delete-domain-association` call. The blocker was never cross-account cooperation; it was that the ownership search looked in the wrong place — see "Why the ownership search missed it".

**What this now needs is an owner go-ahead on timing, not a queue.** Removing the domain association takes the legacy site down, and apex/`www` stay down until the `NdnWebStack` deploy claims the aliases and DNS is repointed — a **~10–20 minute outage**, structurally unavoidable (CloudFront will not accept an alias until it is released). That is much longer than the ~72-second window of the 2026-08-15 attempt, and is why this is scheduled rather than run on sight. Revised step 4 is below. **Do not run it without the owner's go-ahead on a window.**

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

**Why this is a different, harder problem than the step-3 failure:** the step-3 failure was a *DNS-based* pre-check ("does this alias's DNS currently point elsewhere") that a DNS-first ordering was expected to satisfy. This one is CloudFront's actual **alias-uniqueness constraint**: an alternate domain name can only be attached to *one* CloudFront distribution at a time, globally, across every AWS account — and it is enforced against the distribution's own configuration, not DNS. The legacy distribution `d2z3fclxq13w3z.cloudfront.net` still has `nourishthenerve.com`/`www.nourishthenerve.com` configured as *its* aliases. Repointing DNS doesn't release that claim — only removing the alias from the legacy distribution's own configuration does. There is no DNS trick, deploy-ordering trick, or retry that gets around it. (This paragraph originally went on to say that distribution "lives in the unidentified third AWS account this project has never held credentials for". That was wrong — it is Amplify-managed from `803129122420`, see "Holder identified" below. The analysis of the constraint itself stands unchanged; only the attribution was mistaken.)

**Path forward — RESOLVED 2026-08-21 as option 1.** The two options below were written on 2026-08-15, when the holder was believed external. Option 1 is what actually applies, and it was never closed:

1. **Get the alias removed from the holding distribution's own configuration**, after which `NdnWebStack` can claim it immediately, exactly as it would any fresh alias. **This is the live path.** The holder turned out to be an Amplify app in our own `803129122420` — see "Holder identified" below — so "cooperation" means one CLI call, not a conversation.
2. ~~An AWS Support case to move the alternate domain name cross-account.~~ **Moot** — the case was filed and its useful output was the identification in (1), not a move. AWS explicitly handed the action back: the domains are in an account we control, so we remove them ourselves.
3. Still true, and still the thing to respect: this is **a prerequisite release, not a retry of step 4**. The same DNS-then-deploy sequence fails identically every time until the alias is actually released. What changed is only *who* can release it.

## Holder identified — 2026-08-21

AWS Support replied to the case and named the holder. Verified independently against `803129122420` before acting on it:

```console
$ aws --profile default --region eu-west-2 amplify list-domain-associations --app-id dty9c1kqh8zkh
domainAssociationArn: arn:aws:amplify:eu-west-2:803129122420:apps/dty9c1kqh8zkh/domains/nourishthenerve.com
domainStatus:         AVAILABLE
subDomains:
  (apex)  CNAME d2z3fclxq13w3z.cloudfront.net
  www     CNAME d2z3fclxq13w3z.cloudfront.net
```

That is the distribution this runbook has been chasing since 2026-08-14. Corroborated: `https://main.dty9c1kqh8zkh.amplifyapp.com` serves byte-identical content to `www.nourishthenerve.com` (both `content-length: 26876`).

| | |
|---|---|
| Amplify app | `ndn-frontend`, appId **`dty9c1kqh8zkh`**, `eu-west-2` |
| Account | **`803129122420`** — root access held |
| Source | `github.com/nourishthenerve/ndn-frontend` |
| Created / last deployed | 2026-01-21 / 2026-02-24 |

**One correction to AWS's reply:** it gives the App ID as `d33x5xdydlevqa`. No such app exists — `amplify list-apps` across all regions returns exactly one app in this account, `dty9c1kqh8zkh`. Everything else in their message checks out, so treat it as a transcription error on their side and use the real ID when replying to them.

## Why the ownership search missed it

The section this replaces concluded, on 2026-08-15, that the distribution sat in an account "nobody on this project can currently sign into", and instructed **"do not spend more time searching for it"**. That conclusion was wrong, and the instruction pointed the search away from the answer for six days. Recorded here rather than quietly deleted, because the failure mode generalises.

The evidence at the time was:

- `aws cloudfront list-distributions` (as `arn:aws:iam::803129122420:root`) returned exactly **4** distributions, all `islamicmaps.org` (`app`/`landing`/`api`/`cdn`). No `d2z3fclxq13w3z`, no `nourishthenerve.com` alias on any of them.
- `aws organizations list-accounts` — `803129122420` is the management account of org `o-tsnehqxpmj`, whose only members are itself and `357601815388`. No forgotten sibling account.

Both commands were run correctly and both outputs were accurate. The error was the inference drawn from them: **Amplify-managed CloudFront distributions do not appear in the owning account's `list-distributions`.** Amplify provisions them in an AWS-owned service account, so an Amplify-fronted domain is invisible to every CloudFront-side query you can run against your own account. The listing was complete for distributions the account *owns*; it was never complete for domains the account *controls*, and only the second question mattered.

That also disposes of the `155257` lead recorded below: it is AWS's own Amplify service account, not a former agency's or an old personal one. It was never worth chasing.

**The command that would have found this on day one is `aws amplify list-apps`.** Generalised: when a CloudFront alias conflict points at an account you appear not to control, check the services that front CloudFront on your behalf — Amplify first, then App Runner, then edge-optimised API Gateway — in the accounts you *do* control, before concluding the holder is external.

## Support-case prerequisites — completed 2026-08-15, now largely moot

Kept because one of the two is still load-bearing. These were AWS's prerequisites for the cross-account move, which is no longer the path (see "Path forward"). Neither moves traffic.

- **The TXT records (1) are now pointless but harmless** — leave or delete them; they validate a move that will not happen. Deleting is tidier, and is listed under "Post-cutover cleanup".
- **The certificate (2) is still essential**, for an unrelated reason: it must cover apex/`www` *before* those aliases are added, or the deploy fails on a certificate/alias mismatch. It is already attached. Nothing to redo.

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

Fixed at the time by decoupling: `domainNames` went back to `[DOMAIN_NAME]` while `CERTIFICATE_ARN` stayed on the three-SAN cert `c7f37883-1f9e-4abc-94b3-18fb028cf9e2`, guarded by a test asserting the aliases were absent.

**Superseded 2026-08-21.** With the release now self-service, `APEX_DOMAIN_NAME`/`WWW_DOMAIN_NAME` have rejoined `domainNames` and the guard test is inverted: `claims apex/www alongside next., all covered by the three-SAN certificate` now asserts the aliases are present *and* that the attached cert is the one covering them — the same mismatch protected against, from the other side. **The decoupling's whole point survives as deploy ordering:** the release must happen before this deploys, or CloudFormation rolls the update back and takes the certificate with it again.

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

**The owning account ends `155257` — and this was read wrongly on 2026-08-21.** It is neither `803129122420` nor `357601815388`, and that was taken as independent confirmation that the holder was a third party, plus "a concrete identifier the site owner may recognise". It is neither. **`155257` is AWS's own Amplify service account** — where Amplify provisions the CloudFront distributions it manages on a customer's behalf. An Amplify-fronted domain always reports a conflicting account you have never heard of, because you do not own the distribution; you own the Amplify app in front of it.

So the correct reading of this table is: *"the conflict is real, and the holding distribution is service-managed rather than customer-owned"* — which is a pointer **toward** Amplify/App Runner in your own accounts, not away from them. See "Why the ownership search missed it".

Strictly, the masked ID cannot be compared against a domain name, so this does not *prove* the conflicting distribution is `d2z3fclxq13w3z.cloudfront.net`. The Amplify domain association names that exact CloudFront domain, so in practice they are the same thing.

## Status re-verified 2026-08-21

Nothing has drifted; the table below is the pre-cutover baseline to compare against after step 4.

**Support case: answered, and closed out the blocker.** Filing was necessarily a console action for the owner, since both accounts are Basic and `support create-case` is unavailable to this project (`SubscriptionRequiredException`) — which also means this repo could not read the reply, and it reached us by the owner pasting it in. Its useful content was the identification, not a move: see "Holder identified".

**The earlier owner decision to park the cutover is superseded.** It was made when the next action was "wait on an AWS queue with no SLA". The next action is now a command we can run, so what remains is choosing a window for the ~10–20 minute outage — see step 4. Gate G1 stays not-met on the apex criterion until that runs (`docs/plan/gate-g1-report.md`).

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

## Remaining steps — unblocked, awaiting an owner-chosen window

### Step 4 (revised 2026-08-21): release the Amplify claim, deploy, then repoint DNS

**The 2026-08-15 ordering is dead.** It put DNS first and the deploy second, which was correct when the only obstacle was believed to be a DNS-based pre-check. It is wrong now: the alias must be *released* before CloudFront will accept it, so the release comes first and DNS comes last. Running the old order reproduces the ~72-second error window and a failed deploy, nothing more.

**Prerequisite: the code change adding `APEX_DOMAIN_NAME`/`WWW_DOMAIN_NAME` to `domainNames` is reviewed and green, but NOT yet merged.** `ci.yml`'s `deploy` job triggers on any push to `main` that touches code (`if: github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.changes.outputs.code == 'true'`), so **merging is what fires the deploy** — there is no "merge now, deploy later". Merging before the release therefore produces a guaranteed failed deploy.

Two ways to sequence this. The default below is (a):

**(a) Merge inside the window, after the release — recommended.** The merge *is* step 4.3. Costs a few extra minutes inside the outage (`quality` must pass before `deploy` starts, they are not parallel), but `main` never carries a deliberately-broken deploy.

**(b) Merge early, accept one failed deploy, re-dispatch at the window.** The failed deploy is genuinely harmless and this is proven, not assumed — the 2026-08-15 attempt rolled `NdnWebStack` back cleanly in ~14 seconds and `next.` never stopped serving. Shortens the outage, because re-dispatching `deploy` skips the `quality` wait. The cost is a red `main` and a failed production deploy that a future reader has to be told was intentional. Choose this only if the outage minutes genuinely matter more.

Either way the ordering rule is the same and is not negotiable: **nothing deploys until `list-conflicting-aliases` reports `Quantity: 0`.**

**Expected outage: ~10–20 minutes**, apex and `www` both, from 4.1 until 4.4 propagates. Dominated by the CloudFront distribution update in 4.3. Unavoidable — CloudFront will not accept an alias that is still claimed, so the release and the claim cannot overlap. Choose a low-traffic window. `next.nourishthenerve.com` is unaffected throughout and keeps serving the new site.

1. **Release the aliases** (manual, `default` profile — `803129122420`):

   ```bash
   aws --profile default --region eu-west-2 amplify delete-domain-association \
     --app-id dty9c1kqh8zkh --domain-name nourishthenerve.com
   ```

   This is the destructive step and the start of the outage: it takes the legacy site off apex/`www`. It does **not** delete the Amplify app or its build — that stays reachable at `https://main.dty9c1kqh8zkh.amplifyapp.com`, which is what makes step 4's rollback possible at all. Expect Amplify to also remove the apex `A`/ALIAS and `www` `CNAME` it manages in Route 53, so the hostnames will likely go NXDOMAIN rather than serve an error page.

2. **Confirm the release before deploying anything.** Do not skip this and do not substitute a deploy attempt for it:

   ```bash
   aws --profile ndn-prod cloudfront list-conflicting-aliases \
     --alias nourishthenerve.com --distribution-id E1K6OYW4X46BJZ
   aws --profile ndn-prod cloudfront list-conflicting-aliases \
     --alias www.nourishthenerve.com --distribution-id E1K6OYW4X46BJZ
   ```

   Both must report `Quantity: 0`. Poll until they do. A deploy launched early fails and rolls back, adding a full distribution-update cycle to the outage for nothing.

3. **Deploy `NdnWebStack`** to claim the aliases — under (a), merge the PR and let `deploy` fire; under (b), re-dispatch the `deploy` job on `main`. This is the long pole (a CloudFront distribution update, typically 5–15 minutes, plus ~5 for `quality` under (a)). Wait for `UPDATE_COMPLETE` **and** for the distribution to report `Deployed`; one still `InProgress` will not serve the new aliases reliably.

4. **Repoint DNS** in the `803129122420` zone (manual, `default` profile — `ndn-deploy` has no access there). Amplify most likely deleted these records in 4.1, so this is usually a `CREATE`, not an `UPSERT` — check before assuming:

   ```bash
   # Apex: A/ALIAS -> dbn8dfhgi712k.cloudfront.net (Route 53 ALIAS, no TTL)
   # www:  CNAME   -> dbn8dfhgi712k.cloudfront.net, TTL 60
   ```

5. Proceed to step 5's verification below.

**Rollback, if 4.3 fails and cannot be fixed quickly:** re-add the domain association in Amplify (`amplify create-domain-association`, same app ID, `main` branch, apex + `www` subdomains). Be aware this is *slow* — Amplify re-runs certificate validation, so budget tens of minutes before the legacy site is serving again. Practically, once 4.1 has run, forward is faster than back for anything short of a deploy that cannot be made to work at all.

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
- **Nothing about the CloudFront alias conflict changes.** The claim lives in the holding distribution's config; deleting our Lambda neither helps nor hinders it. (Written while the holder was believed to be a third account — it is the `ndn-frontend` Amplify app in `803129122420`, and the point stands unchanged either way.)

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
- **Amplify domain association (step 4.1):** re-add it with `amplify create-domain-association` (app `dty9c1kqh8zkh`, branch `main`, apex + `www`). Slow — Amplify re-runs certificate validation, so budget tens of minutes. The Amplify app itself is never deleted by this runbook, so this rollback stays available indefinitely.
- **CloudFront alternate domain names (step 3/4.3):** to drop the aliases again, remove `APEX_DOMAIN_NAME`/`WWW_DOMAIN_NAME` from `domainNames` and redeploy. The certificate half is independent: to revert it, point `CERTIFICATE_ARN` back at `b1f9e01e-ab10-43b8-944a-6c0ccfffacb5` — though there is no reason to, since the three-SAN cert covers `next.` identically and is what lets the aliases be claimed at all.
- **Domain-control validation TXT records:** harmless to leave in place indefinitely — they name hostnames (`_.`/`_www.`) nothing resolves for real, and affect no live record. Now also pointless, since the Support move they were for is not happening. Delete with a `DELETE` change batch on the same two records whenever convenient (this is the "Post-cutover cleanup" referenced above).

## Do NOT

- **Delete the `ndn-frontend` Amplify app, or any other resource in `803129122420`.** Step 4.1 removes *one domain association* and nothing else. The app is the rollback path, and the account is shared with the unrelated `islamicmaps` estate — see [legacy-estate.md](legacy-estate.md).
- Delete, empty, or version-purge the S3 bucket `nourishthenerve` or its prefixes (D-03) — this survives the 2026-08-15 decommission unchanged. The bucket is now inert and unreachable; removing it needs an explicit owner decision recorded against D-03, not an inference from "remove the legacy estate."
- Run step 4 without explicit, same-session confirmation from the site owner, on a window they have chosen. It is a deliberate outage now, not just a risky change.
- Run step 4's sub-steps out of order, or skip 4.2. Releasing then deploying blind, or deploying before the release lands, turns a ~10–20 minute outage into a longer one with a rolled-back stack at the end of it.
