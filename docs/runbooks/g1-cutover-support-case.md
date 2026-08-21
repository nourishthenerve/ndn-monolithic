# AWS Support case — move `nourishthenerve.com` / `www.nourishthenerve.com` to our CloudFront distribution

**Task:** [05-execution-plan.md § TASK 1.6.1](../plan/05-execution-plan.md) · **Blocks:** the G1 DNS cutover ([g1-cutover.md](g1-cutover.md)) · **Drafted:** 2026-08-15 · **Status: not yet filed**

This is the text to file at <https://console.aws.amazon.com/support/home>. Prerequisites are already complete — see "Support-case prerequisites" in [g1-cutover.md](g1-cutover.md).

## How to file it

| Field | Value |
|---|---|
| **Account to file from** | `357601815388` (`ndn-prod`) — the account owning the *target* distribution |
| **Case type** | Account and billing |
| **Service** | Billing (or "Account" if Billing offers no suitable category) |
| **Category** | Other / General account question |
| **Severity** | General guidance |
| **Subject** | `CNAMEAlreadyExists: move nourishthenerve.com + www to distribution E1K6OYW4X46BJZ` |

**On case type:** both accounts are on Basic support, which excludes *technical* cases (`describe-severity-levels` → `SubscriptionRequiredException`). Domain-move requests like this are normally accepted under **Account and Billing**, which Basic does cover. If it is bounced as technical, reply asking for it to be routed to the CloudFront team as a domain-ownership dispute rather than a technical support request — this is a fixed AWS-side operation, not troubleshooting. Escalating to a paid plan for one case is a last resort, not the first response.

**Before sending:** confirm the two TXT records still resolve, since AWS will check them, and confirm the conflict is still there at all — if `Quantity` has dropped to `0`, the names are already free and there is nothing to file:

```bash
dig +short TXT _.nourishthenerve.com @8.8.8.8      # -> "dbn8dfhgi712k.cloudfront.net"
dig +short TXT _www.nourishthenerve.com @8.8.8.8   # -> "dbn8dfhgi712k.cloudfront.net"

aws --profile ndn-prod cloudfront list-conflicting-aliases \
  --alias nourishthenerve.com --distribution-id E1K6OYW4X46BJZ
aws --profile ndn-prod cloudfront list-conflicting-aliases \
  --alias www.nourishthenerve.com --distribution-id E1K6OYW4X46BJZ
```

All four re-verified 2026-08-21: TXT records resolve, and both aliases are still held by one distribution `*******0TMKEWA` in account `******155257` (AWS masks all but the trailing characters).

**Ask the owner first — this may make the case unnecessary.** `155257` is neither `803129122420` nor `357601815388`. If the site owner recognises an AWS account ending `155257` and can still sign into it, deleting the two aliases from that distribution's own configuration releases them in minutes, and `NdnWebStack` claims them on the next ordinary deploy — no case, no queue, no SLA. File this only once that has been ruled out.

## Case body — copy from here

> **Subject:** `CNAMEAlreadyExists: move nourishthenerve.com + www.nourishthenerve.com to distribution E1K6OYW4X46BJZ`
>
> Hello,
>
> I am requesting that two alternate domain names be moved to my CloudFront distribution, following the process in "Move an alternate domain name" → "Contact AWS Support to move an alternate domain name". I own the domain and control its DNS, but the distribution currently holding the alternate domain names is in an AWS account I cannot access, so I cannot release them myself.
>
> **Domain names to move**
>
> - `nourishthenerve.com` (apex)
> - `www.nourishthenerve.com`
>
> **Target distribution (mine, please move the names to this one)**
>
> - Distribution ID: `E1K6OYW4X46BJZ`
> - Domain name: `dbn8dfhgi712k.cloudfront.net`
> - AWS account: `357601815388`
>
> **Source distribution (currently holds the names; not my account)**
>
> - Domain name: `d2z3fclxq13w3z.cloudfront.net`
> - Per `cloudfront list-conflicting-aliases` run from my account against my target distribution, both names are held by one distribution, reported masked as `*******0TMKEWA` in account `******155257`. That account is neither of the two I control.
>
> **Proof of domain ownership**
>
> I control the `nourishthenerve.com` public hosted zone: `Z09601252VHSWVDDK2RH4`, in AWS account `803129122420`. This is the authoritative zone for the domain — its NS records are the ones the `.com` registry delegates to (`ns-1474.awsdns-56.org`, `ns-1774.awsdns-29.co.uk`, `ns-47.awsdns-05.com`, `ns-808.awsdns-37.net`).
>
> As required for a cross-account move, I have created the domain-control validation TXT records pointing at the target distribution:
>
> ```text
> _.nourishthenerve.com.      TXT  "dbn8dfhgi712k.cloudfront.net"
> _www.nourishthenerve.com.   TXT  "dbn8dfhgi712k.cloudfront.net"
> ```
>
> Both are live and publicly resolvable now.
>
> I have also attached an ACM certificate covering both names (plus `next.nourishthenerve.com`) to the target distribution: `arn:aws:acm:us-east-1:357601815388:certificate/c7f37883-1f9e-4abc-94b3-18fb028cf9e2`, status ISSUED, validated by DNS against the same hosted zone. I can add any further TXT record you need as further proof.
>
> **Why I cannot resolve this myself**
>
> The source distribution `d2z3fclxq13w3z.cloudfront.net` is in a third AWS account set up years ago for the domain's original website, which I no longer have any credentials for. I have confirmed it is not in either account I do control:
>
> - In `803129122420` (checked as the account root), `cloudfront list-distributions` returns only four distributions, all for an unrelated domain (`islamicmaps.org`). Neither `nourishthenerve.com` name appears on any of them.
> - `803129122420` is the management account of AWS Organization `o-tsnehqxpmj`, whose only member accounts are itself and `357601815388`. There is no other account of mine that could hold it.
>
> Because the source distribution is in an account I cannot access, and is still enabled, neither `update-domain-association` nor `associate-alias` is available to me (both require the source to be disabled for a cross-account move), and the wildcard method does not apply to an apex domain.
>
> **What I am asking for**
>
> Please verify my ownership of `nourishthenerve.com` and move both `nourishthenerve.com` and `www.nourishthenerve.com` from the source distribution to distribution `E1K6OYW4X46BJZ` in account `357601815388`.
>
> The domain currently serves a live website from the source distribution, so I would like to keep the switchover tight. Once you confirm the names are released and attached to my distribution, I will repoint the apex and `www` DNS records to `dbn8dfhgi712k.cloudfront.net` immediately — the `www` TTL is already lowered to 60 seconds in preparation. If you would rather I repoint DNS at a particular point in your process, tell me when and I will do it on your timing.
>
> Please let me know if you need anything further to verify ownership.
>
> Thank you,
> Mohammed Zia

## When AWS confirms the move

1. Verify the names actually released, from `ndn-prod`:

   ```bash
   aws --profile ndn-prod cloudfront list-conflicting-aliases \
     --alias nourishthenerve.com --distribution-id E1K6OYW4X46BJZ
   ```

   Expect `Quantity: 0`. While the conflict stands it returns `Quantity: 1` naming `*******0TMKEWA` / `******155257` (as of 2026-08-21), so this is an unambiguous released/not-released signal — poll it rather than retrying a deploy to find out.

   AWS may attach the names to `E1K6OYW4X46BJZ` themselves. If they do, `get-distribution` shows all three aliases and the CDK code below just catches up with reality; if they only release them, the deploy claims them.

2. Re-add the aliases in code — restore `domainNames` to `[DOMAIN_NAME, APEX_DOMAIN_NAME, WWW_DOMAIN_NAME]` in `infra/src/web-stack.ts`, and update the decoupling regression test that currently asserts their absence. Deploy via the normal CI path.

3. Only then run the g1-cutover runbook's step 4 (DNS repoint) — and note the ordering problem that broke the first attempt is *gone* once the aliases are already attached: DNS can move last, with no error-page window.

4. Continue from step 5 of [g1-cutover.md](g1-cutover.md) (verify, observe 24–48h, then decommission the legacy Lambda).
