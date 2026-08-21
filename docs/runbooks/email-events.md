# Email bounce, complaint and reputation handling

**Date:** 2026-08-21 · **Completes:** the bounce/complaint follow-up TASK 1.4.1 and TASK 1.5.2 each deferred · **Decisions:** ADR-0009 · **Related:** [ses-production-access.md](ses-production-access.md)

## Why this exists now

Both SES senders shipped without any observability on delivery failure. `ses-production-access.md` recorded the gap honestly at the time — "no SNS topic wired to bounce-complaint notifications beyond SES's default email forwarding" — and both tasks deferred it as a later concern.

Two things made it a now concern. AWS asked about it directly when reviewing the production-access request ("how you manage bounces, complaints, and unsubscribe requests"), and the reply sent on 2026-08-21 said we would build it. And the honest answer to the question was thinner than it looked: an account-level suppression list plus feedback forwarding means a bad address quietly stops receiving mail and an email lands in a mailbox. There is nothing to alarm on, nothing to measure, and no way to notice a pattern before AWS does.

## What was built

All in `NdnWebStack`, since both senders live there. `infra/src/email-events.ts` owns it; `infra/src/config.ts` holds the one shared name.

| Resource | Detail |
|---|---|
| SES configuration set | `ndn-email`. Suppression restated at set level (`BOUNCES_AND_COMPLAINTS`) so it survives a change to the account default; reputation metrics enabled, which is what publishes `Reputation.*` to CloudWatch. |
| Event destination | SNS, matching `BOUNCE`, `COMPLAINT`, `REJECT`, `RENDERING_FAILURE`. |
| SNS topic | `ndn-email-events`, with an email subscription to `ALERT_EMAIL` — same shape `budget-stack.ts` uses for the log-ingestion alarm. |
| Alarms | `ndn-email-bounce-rate` (> 3%) and `ndn-email-complaint-rate` (> 0.1%), both `AWS/SES` `Reputation.*`, both notifying the same topic. |
| Both senders | `ses.ts` now sets `ConfigurationSetName` on every `SendEmailCommand`, from the `SES_CONFIGURATION_SET_NAME` env var. |
| IAM | Each `ses:SendEmail` grant now covers the configuration-set ARN as well as the identity ARN. |

### Why only the failure events

`DELIVERY`, `SEND` and `OPEN` are deliberately excluded. A human's inbox is subscribed to this topic, and a notification per successful send would turn it into noise — after which nobody reads the bounce either. There is a test asserting those three never appear in the matched events, because "add delivery confirmations too" is a reasonable-sounding change that would quietly break the thing this exists to do.

### Why the alarm thresholds are below AWS's

AWS reviews sending accounts at roughly 5% bounce and 0.1% complaint. Bounce alarms at 3%, complaint at 0.1%. At this volume a handful of bad addresses is the difference between fine and under review, and the point of the alarm is to find out before AWS does rather than at the same time.

### The IAM detail worth knowing

Naming a configuration set in `SendEmail` makes it a resource of the call. A role authorised on the identity but not on the set gets `AccessDenied` on **every** send — so this change had to touch the grants, not just the code. Both statements now list both ARNs, and a test asserts it.

## Owner action — confirm the SNS subscription

AWS sends a **"Subscription Confirmation"** email to `mohammed.zia33+ndnprod@gmail.com` when the topic is first created. **Until the link in it is clicked, the topic delivers nothing** — no bounce notification, no alarm. It fails silently and looks identical to "no bounces have happened".

Confirm it after the first deploy that includes this, then verify:

```bash
aws --profile ndn-prod sns list-subscriptions-by-topic \
  --topic-arn arn:aws:sns:eu-west-2:357601815388:ndn-email-events \
  --query 'Subscriptions[].{Endpoint:Endpoint,Arn:SubscriptionArn}'
```

A `SubscriptionArn` of `PendingConfirmation` means it is not yet live.

## Verifying after deploy

```bash
aws --profile ndn-prod sesv2 get-configuration-set --configuration-set-name ndn-email
aws --profile ndn-prod sesv2 get-configuration-set-event-destinations --configuration-set-name ndn-email
aws --profile ndn-prod cloudwatch describe-alarms \
  --alarm-names ndn-email-bounce-rate ndn-email-complaint-rate \
  --query 'MetricAlarms[].{Name:AlarmName,State:StateValue}'
```

Both alarms should sit in `INSUFFICIENT_DATA` until mail actually flows — nothing has been sent from this account yet (`SentLast24Hours: 0`), and `treatMissingData: NOT_BREACHING` means a quiet hour is not a breach.

**End-to-end testing needs SES's mailbox simulator**, not a real address: sending to `bounce@simulator.amazonses.com` or `complaint@simulator.amazonses.com` produces a real event without harming reputation, and works in the sandbox. Worth doing once the contact form's flag is turned on, not before — the senders are unreachable while the feature flags are off.

## What this deliberately does not do

- **No application-side bounce handling.** SES's suppression list already stops sending to an address that hard-bounced or complained, account-wide and automatically. Duplicating that in a Lambda and a DynamoDB table would be more code doing the same job worse. If a reason to act on events programmatically appears later — say, marking a patient record's address unreachable in the UI — the topic is already there to subscribe to.
- **No unsubscribe mechanism.** Every message this system sends is transactional and recipient-initiated; there is no list to leave. Notification preferences for registered users are a Phase 2 concern, and the data model already separates them from clinical records (TASK 0.3.4).
- **No `MAIL FROM` domain.** Not required for DKIM/DMARC alignment or for any of the above.

## Cost

£0.00. SES configuration sets, event publishing and reputation metrics are free; SNS is free at this volume (well inside the 1,000 free email notifications/month); two CloudWatch alarms sit inside the 10-alarm free tier alongside the three that already exist.

## Rollback

Revert the branch. The configuration set, topic, subscription and alarms are all created by `NdnWebStack`, so a redeploy removes them; the senders stop naming a configuration set and go back to sending exactly as before. Account-level suppression and feedback forwarding are AWS-side settings this never touched, so bounce protection itself does not regress — only the visibility added here.
