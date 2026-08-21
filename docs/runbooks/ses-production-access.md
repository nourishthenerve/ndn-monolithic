# SES domain verification + production-access request (LL-01)

**Date:** 2026-08-13 · **Account:** `ndn-prod` (`357601815388`, eu-west-2) · **Decisions:** D-24, ADR-0009 · **Long-lead:** LL-01

## Why this ran now

Flagged as an unraised gap in the Gate G0 review (`gate-g0-report.md`): the plan scheduled SES production access to start in Phase 0 given its days-to-2-week lead time, and it blocks all outbound email through G1 (Phase 1's contact form and workshop confirmation emails need it). Actioned as a same-day follow-up to that review, with the account owner's confirmation.

## What was done

1. **Domain identity created** in SES (`ndn-prod`, eu-west-2): `aws sesv2 create-email-identity --email-identity nourishthenerve.com` — Easy DKIM (RSA 2048), 3 CNAME tokens returned.
2. **DNS records added** to the `nourishthenerve.com` hosted zone in `803129122420` (`Z09601252VHSWVDDK2RH4`) — the only zone touched; `islamicmaps.org` untouched:
   - 3 DKIM CNAMEs: `<token>._domainkey.nourishthenerve.com` → `<token>.dkim.amazonses.com`.
   - **New DMARC record** (`_dmarc.nourishthenerve.com` TXT): `v=DMARC1; p=none; rua=mailto:contact@nourishthenerve.com` — closes decision **D-24**, which called for this and had not yet been implemented. `p=none` is monitor-only by design: it reports on SPF/DKIM alignment without rejecting or quarantining anything, the standard safe first step before tightening to `p=quarantine`/`p=reject` once the aggregate reports confirm no legitimate mail (Zoho human-sent or SES transactional) is failing alignment.
   - **Existing SPF record extended**, not replaced: `v=spf1 include:zohomail.eu ~all` → `v=spf1 include:zohomail.eu include:amazonses.com ~all`. Zoho's inbound MX and existing verification TXT were left untouched.
3. **Verified**, ~1 minute after DNS propagated: `aws sesv2 get-email-identity` → `VerifiedForSendingStatus: true`, `DkimAttributes.Status: SUCCESS`.
4. **Production-access request submitted**: `aws sesv2 put-account-details --mail-type TRANSACTIONAL --website-url https://nourishthenerve.com --production-access-enabled ...` with a use-case description covering the three transactional email types this platform will send (contact-form relay, workshop confirmations, future appointment/account notifications) and noting the DKIM/SPF/DMARC setup and the SMS channel's existing rate-limit/suppression design. Confirmed recorded: `aws sesv2 get-account` → `Details.ReviewDetails.Status: PENDING`.

## What this does not do yet

- **Still sandboxed** (`ProductionAccessEnabled: false`) — **this was true pending review on 2026-08-13; the review has since been DENIED, see "Production access denied" below.** The original text is kept as written: until AWS completes its review — typically hours to a few business days for a small transactional request, within the plan's "days–2wk" estimate. No code in this repo depends on production access yet (TASK 1.4.1/1.5.2 do, and aren't built).
- No `MAIL FROM` domain configured (SES's default subdomain is used) — not required for DKIM/DMARC alignment or production access; can be added later if bounce-handling needs it.
- No SNS topic wired to `FeedbackForwardingStatus`/bounce-complaint notifications beyond SES's default email forwarding — a Phase 1 task (1.4.1/1.5.2) concern, not this one's.

## Rollback

- DNS: remove the 3 DKIM CNAMEs and the `_dmarc` TXT record; revert the SPF TXT record to `v=spf1 include:zohomail.eu ~all` — all independently reversible, none affect Zoho inbound mail.
- SES: `aws sesv2 delete-email-identity --email-identity nourishthenerve.com` — harmless before production access is granted (no mail has been sent).

## Cost delta

£0.00 — domain identity, DKIM, and the production-access request are all free; SES send volume remains £0 until Phase 1 code actually sends anything.

## Production access denied — found 2026-08-21 (Gate G1)

The request above was **refused**. Found during the Gate G1 review ([gate-g1-report.md](../plan/gate-g1-report.md) §6), not by a notification reaching this repo:

```bash
aws --profile ndn-prod sesv2 get-account
# ProductionAccessEnabled: false
# Details.ReviewDetails: { "Status": "DENIED", "CaseId": "178661888300813" }
```

AWS's reason is not exposed through the API — it is emailed to the account address, and Basic support blocks the Support API (`SubscriptionRequiredException`), so it can only be read from that inbox or the console.

**The identity itself is fine.** `get-email-identity` still returns `VerifiedForSendingStatus: true`, `DkimAttributes.Status: SUCCESS`, signing enabled. DKIM, SPF and DMARC are all as this runbook left them. Nothing needs re-verifying; only the sandbox restriction stands.

### What the sandbox actually blocks

Sandbox mode permits sending **to verified identities only**. `nourishthenerve.com` is a verified *domain* identity, which covers every address at that domain. So:

| Sender | Recipient | Works in sandbox? |
|---|---|---|
| Contact-form relay (TASK 1.4.1) | `contact@nourishthenerve.com` | **Yes** — inside the verified domain |
| Workshop registration confirmation (TASK 1.5.2) | arbitrary registrant address | **No** — `MessageRejected` |

Neither is failing in production today, because both features are flag-gated off and the flag layer cannot currently be switched on at all (gate-g1-report.md §3a). But this blocks TASK 1.5.2's DoD from the moment workshop registration goes live.

### Next action — appeal, don't re-request

Re-submitting the same `put-account-details` payload will be refused the same way. Read AWS's stated reason from the account email first, then reply on case `178661888300813` addressing it directly. Denials for small transactional senders usually turn on the use-case description being too thin about **volume, recipient provenance, and bounce/complaint handling** — so an appeal should state: expected volume (single-digit emails/day at launch), that every recipient has just submitted a form or completed a paid registration (never a purchased or scraped list), that mail is transactional-only with no marketing, and how bounces and complaints are handled. Note that the current setup has no SNS bounce/complaint topic beyond SES's default forwarding — standing one up before appealing is a cheap, concrete improvement to point at.

**Owner action.** This is an AWS-console/email step, not something this repo can drive.
