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

Re-submitting the same `put-account-details` payload will be refused the same way. Read AWS's stated reason from the account email first, then reply on case `178661888300813` addressing it directly. Denials for small transactional senders usually turn on the use-case description being too thin about **volume, recipient provenance, and bounce/complaint handling** — so an appeal should state: expected volume (single-digit emails/day at launch), that every recipient has just submitted a form or completed a paid registration (never a purchased or scraped list), that mail is transactional-only with no marketing, and how bounces and complaints are handled. **Done** — see "The reply sent" and "Bounce handling, built" below.

- **Account-level suppression list: enabled for `BOUNCE` and `COMPLAINT`** (`get-account` → `SuppressionAttributes.SuppressedReasons`). SES automatically suppresses an address account-wide once it hard-bounces or generates a complaint, without any application code.
- **Feedback forwarding: on** (`FeedbackForwardingStatus: true`) — bounce and complaint notifications are delivered by email.
- **Not in place when the reply was written:** a configuration set with an SNS event destination, i.e. programmatic bounce/complaint handling. `list-configuration-sets` returned nothing and the only SNS topic in the account was `ndn-log-ingestion-alarm`; no application code referenced bounces or complaints. The reply below says so plainly rather than claiming otherwise. **Built later the same day** — see "Bounce handling, built" below.

### The reply sent — case `178661888300813`, 2026-08-21

**Sent by the owner on 2026-08-21**, reopening the case rather than submitting a fresh request. Awaiting AWS. Kept here as the record of what was said, and because the third answer below is a commitment that has since been honoured — see "Bounce handling, built" at the end.

> Thank you — apologies for the delayed reply, and here is the detail you asked for.
>
> **How often we send, and volume**
>
> Very low, and entirely event-driven — there is no scheduled or batch send anywhere in the system. At launch we expect single figures per day, and we do not expect to exceed a few dozen on any day. Three senders, in the order they go live:
>
> 1. *Contact-form relay* — one email per website contact-form submission, sent to our own `contact@nourishthenerve.com` mailbox. Realistically a handful per week.
> 2. *Workshop registration confirmation* — one email to the person who has just completed a Stripe Checkout payment for a workshop place. Workshops are occasional; a busy one is a few dozen attendees, spread over the booking window.
> 3. *Appointment reminders and account notifications* (later phase) — to registered, authenticated patients and clinicians only, one per appointment or account event.
>
> **How recipient lists are maintained**
>
> We do not maintain recipient lists. There is no mailing list, no import, no purchased or rented list, and no bulk send capability in the application at all. Every message is triggered by a specific action taken by that specific person moments earlier: they submitted our contact form, they completed and paid for a booking, or they have an appointment in an account they registered for. The only addresses we store are on patient and clinician account records, used solely to notify that person about their own account.
>
> **How we manage bounces, complaints and unsubscribes**
>
> - The account-level suppression list is enabled for both `BOUNCE` and `COMPLAINT`, so SES suppresses an address automatically once it hard-bounces or a recipient complains.
> - Feedback forwarding is enabled, so bounce and complaint notifications reach a monitored mailbox.
> - Before we send at any real volume we will add a configuration set with an SNS event destination for bounces, complaints and deliveries, so handling is programmatic rather than manual. We would rather tell you what is in place today than describe this as done.
> - On unsubscribes: all of this mail is transactional and recipient-initiated, and we send no marketing or promotional email, so there is no list to unsubscribe from. Registered users will be able to manage their own notification preferences in their account. Our data model already separates personal and contact attributes (including marketing preferences) from clinical records specifically so those preferences can be honoured and changed independently.
>
> **Examples of the email we send**
>
> These are the two live templates, verbatim. Both are plain text.
>
> Contact-form relay — to our own mailbox, with the submitter's address as `Reply-To` so staff can reply directly to them:
>
> ```text
> Subject: Contact form message from {name}
>
> {the message the visitor typed}
> ```
>
> Workshop registration confirmation — to the person who just paid:
>
> ```text
> Subject: You're registered: {workshop title}
>
> Your registration for "{workshop title}" is confirmed.
>
> Date/time (UTC): {date and time}
>
> See you there.
> ```
>
> **Verified identity**
>
> Already in place, as you noted is required: `nourishthenerve.com` is a verified domain identity in eu-west-2 with Easy DKIM (`SUCCESS`, signing enabled), SPF extended to include `amazonses.com` alongside our existing Zoho mail, and a DMARC record published at `p=none` while we monitor alignment.
>
> We are a UK neuro-rehabilitation clinic and this is the transactional mail for our own patient and workshop platform. Happy to provide anything further.

### Bounce handling, built — 2026-08-21

The reply's third answer promised a configuration set with an SNS event destination "before we send at any real volume". That was built the same day rather than left as a commitment, and it supersedes the "Not in place" line in the section above.

In short: SES configuration set `ndn-email` attached to every send by both senders, an SNS destination matching `BOUNCE`/`COMPLAINT`/`REJECT`/`RENDERING_FAILURE` to topic `ndn-email-events` with the alert address subscribed, and CloudWatch alarms on bounce rate (>3%) and complaint rate (>0.1%) — both below AWS's own review thresholds, so a problem surfaces to us before it surfaces to them. Full detail, verification commands and the mailbox-simulator test procedure are in `docs/runbooks/email-events.md`, added on its own branch.

**One owner action came with it, now done:** AWS emails a subscription confirmation to the alert address when the topic is first created, and until that link is clicked the topic delivers nothing — silently, in a way indistinguishable from no bounces having occurred. **Confirmed live** (real `SubscriptionArn`, not `PendingConfirmation`) — found during TASK 5.5.2's runbook consolidation pass, 2026-08-28; see [email-events.md](email-events.md)'s own Owner action section.

If AWS follows up asking for more on bounce handling, that answer is now "here is what runs" rather than "here is what we intend".
