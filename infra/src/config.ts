// TASK 0.4.1: checked-in, non-secret deployment constants. The certificate
// ARN points at a certificate requested and DNS-validated manually ahead of
// any CDK deploy — see docs/runbooks/iac-baseline.md for why (the
// nourishthenerve.com hosted zone lives in a different AWS account,
// 803129122420, than this stack deploys to, so CI's ndn-deploy role cannot
// create the validation record itself).
export const ACCOUNT_ID = '357601815388';
export const REGION = 'eu-west-2';

// A staging hostname only — the apex and www stay on the legacy site until
// Gate G1 (TASK 1.6.1). See docs/plan/05-execution-plan.md TASK 0.4.1.
export const DOMAIN_NAME = 'next.nourishthenerve.com';

// TASK 1.6.1: the two hostnames DNS still points at the legacy account's
// CloudFront distribution as of this task's prep step. Added as alternate
// domain names on NdnWebStack's existing distribution ahead of the actual
// DNS cutover (additive, DNS-invisible — no traffic moves until the G1
// cutover runbook's manual DNS step runs). See docs/runbooks/g1-cutover.md.
export const APEX_DOMAIN_NAME = 'nourishthenerve.com';
export const WWW_DOMAIN_NAME = 'www.nourishthenerve.com';

// TASK 1.6.1: re-requested (not reused/extended — ACM certs are immutable,
// SANs can't be added to an existing one) to cover next./apex/www in one
// cert, same CloudFront-requires-a-single-certificate constraint that
// applies to DOMAIN_NAME below. Region us-east-1 (required for CloudFront),
// against the ndn-prod account; all three SANs DNS-validated via CNAMEs
// added to the nourishthenerve.com hosted zone in 803129122420 (the next.
// SAN's validation CNAME already existed from TASK 0.4.1 and needed no
// change — ACM reuses the same challenge token for a domain it has already
// validated). The TASK 0.4.1 certificate
// (arn:.../b1f9e01e-ab10-43b8-944a-6c0ccfffacb5) is left in place, unused,
// rather than deleted — harmless and free, see that task's rollback note.
export const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:357601815388:certificate/c7f37883-1f9e-4abc-94b3-18fb028cf9e2';

// TASK 0.5.1: where budget and cost-anomaly alerts go. Same address the
// account's root user was created with (docs/runbooks/aws-account-baseline.md)
// — already the one contact point this account's owner monitors.
export const ALERT_EMAIL = 'mohammed.zia33+ndnprod@gmail.com';

// C-01's cap, stated in £ (NFR-02). AWS bills this account in USD (confirmed
// via `aws ce get-cost-and-usage` — Unit: "USD"), so the budget itself must
// be denominated in USD: converted at the same planning rate
// docs/plan/00-index.md and 03-cost-model.md use throughout, £1 = $1.2105
// (the 10%-adverse-buffered ECB rate C-01 requires), giving $24.21.
export const MONTHLY_BUDGET_LIMIT_USD = 24.21;

// Applied to every resource in every stack (Tags.of(app), see bin/app.ts) so
// Cost Explorer can break spend down by project — the execution plan's
// "cost allocation tags on every resource" (TASK 0.5.1).
export const COST_ALLOCATION_TAG_KEY = 'Project';
export const COST_ALLOCATION_TAG_VALUE = 'nourishthenerve';

// TASK 0.5.2 (R-11): "log-volume alarm" — early warning if CloudWatch Logs
// ingestion grows well past 03-cost-model.md's ~2GB/month baseline
// (~67MB/day) before it quietly eats into the £20 cap. Set at ~5x that
// baseline: a month sustained at this rate would cost ~$6.28
// (350MB/day * 30 / 1e9 GB * $0.5985/GB) — already a meaningful slice of
// the $24.21 budget (TASK 0.5.1) without tripping on ordinary variance.
export const LOG_INGESTION_ALARM_THRESHOLD_BYTES = 350_000_000;

// TASK 0.5.2 fix (see docs/runbooks/rollback.md): every log group name ever
// passed to createLogGroup(), in one place. budget-stack.ts sums each
// group's IncomingBytes into a single alarm. This list needs a new entry
// whenever a new createLogGroup() call lands — AWS's PutMetricAlarm API
// rejects any alarm math expression containing a SEARCH() (confirmed
// against the real API, not just CDK synth), so a dynamically-discovered,
// zero-maintenance version of this alarm isn't achievable without a
// separate metric-publishing Lambda, which is more infrastructure than
// this £0.00-cost guard has earned so far.
export const MONITORED_LOG_GROUP_NAMES = [
  '/ndn/health-function',
  '/ndn/smoke-test-function',
  '/ndn/contact-form-function',
  '/ndn/testimonial-submission-function',
  '/ndn/testimonial-moderation-function',
  '/ndn/workshop-checkout-function',
  '/ndn/stripe-webhook-function',
];

// TASK 1.4.1: the SSM SecureString holding the Cloudflare Turnstile secret
// key (D-14) — same out-of-band `aws ssm put-parameter --type SecureString`
// convention ADMIN_API_TOKEN_PARAMETER_NAME documents above; a Turnstile
// account/widget is a manual step for the site owner (docs/runbooks/
// contact-form.md), not something CDK can provision. Shared by
// web-stack.ts (grants ssm:GetParameter and sets the Lambda's
// TURNSTILE_SECRET_PARAMETER_NAME env var) and contact-form-handler.ts's
// own fallback default.
export const TURNSTILE_SECRET_PARAMETER_NAME = '/ndn/turnstile-secret-key';

// TASK 1.4.1 (ADR-0009): the contact-form relay's From/To addresses. From
// is under the verified `nourishthenerve.com` domain identity (docs/
// runbooks/ses-production-access.md); To is the existing Zoho inbox staff
// already read. Not secret — plain deployment constants, same as
// ALERT_EMAIL above.
export const CONTACT_FORM_FROM_EMAIL = 'noreply@nourishthenerve.com';
export const CONTACT_FORM_TO_EMAIL = 'contact@nourishthenerve.com';

// TASK 1.4.1: the SES domain identity verified in docs/runbooks/
// ses-production-access.md — deliberately the apex `nourishthenerve.com`,
// not DOMAIN_NAME (`next.nourishthenerve.com`, this stack's own staging
// CloudFront alias, unrelated to what SES verified). web-stack.ts scopes
// ContactFormFunction's ses:SendEmail grant to exactly this identity's ARN.
export const SES_EMAIL_IDENTITY_DOMAIN = 'nourishthenerve.com';

// The SES configuration set both senders attach every message to, so
// bounces, complaints, rejects and rendering failures are published as
// events rather than only landing in a mailbox via SES's default feedback
// forwarding. TASK 1.4.1 and 1.5.2 each deferred this ("no SNS topic wired
// to bounce-complaint notifications beyond SES's default email
// forwarding" — docs/runbooks/ses-production-access.md); it is built now
// because AWS asked precisely this question when reviewing our
// production-access request, and because a suppression list you cannot
// observe is not a bounce-handling story.
export const SES_CONFIGURATION_SET_NAME = 'ndn-email';

// TASK 0.6.3: every ephemeral per-PR stack's CDK app id is this prefix plus
// the PR number (bin/app.ts). Also the literal ARN-pattern prefix the
// ndn-deploy-pr IAM role's policy is scoped to on the real account
// (docs/runbooks/ephemeral-pr-environments.md) — kept as one named constant
// so the two never drift apart silently.
export const PR_STACK_ID_PREFIX = 'NdnWebStackPr';

// TASK 1.3.2: the SSM SecureString holding ADMIN_API_TOKEN (D-14). Created
// out-of-band (`aws ssm put-parameter --type SecureString`), same reasoning
// CERTIFICATE_ARN documents above — never committed as a value, only this
// name. One constant shared by data-stack.ts (grants ssm:GetParameter and
// sets the Lambda's ADMIN_TOKEN_PARAMETER_NAME env var) and
// content-authoring-handler.ts's own fallback default, so the two can't
// drift apart silently. See docs/runbooks/content-authoring.md.
export const ADMIN_API_TOKEN_PARAMETER_NAME = '/ndn/admin-api-token';

// TASK 1.5.2 (ADR-0010): the SSM SecureStrings holding the Stripe API
// secret key and the webhook signing secret — same out-of-band
// `aws ssm put-parameter --type SecureString` convention every other
// secret in this file documents; a Stripe account/webhook endpoint is a
// manual step for the site owner (LL-03, docs/plan/08-long-lead.md), not
// something CDK can provision. STRIPE_SECRET_KEY_PARAMETER_NAME is read by
// both the checkout function (creates Checkout Sessions) and the webhook
// function (constructs a Stripe client to verify events); the webhook
// signing secret is distinct per Stripe endpoint and read only by the
// webhook function.
export const STRIPE_SECRET_KEY_PARAMETER_NAME = '/ndn/stripe-secret-key';
export const STRIPE_WEBHOOK_SECRET_PARAMETER_NAME = '/ndn/stripe-webhook-secret';

// TASK 1.6.2: the SSM prefix every feature flag lives under — one plain
// `String` parameter per flag, named `<prefix><FlagName>` (so
// `/ndn/flags/contact.form.enabled`), holding exactly `true` or `false`.
// Not SecureString: a flag's state is not a secret, and WithDecryption
// would need a KMS grant for nothing. Shared by web-stack.ts/data-stack.ts
// (grant ssm:GetParameter on the whole prefix and set the Lambda's
// FLAG_PARAMETER_NAME_PREFIX env var) and services/api/src/ssm-flag-source.ts's
// own fallback default, so the two can't drift apart silently.
//
// Unlike the secrets above, these are created by an operator *when they
// want to turn something on* — nothing exists at deploy time and nothing
// needs to, because an absent parameter is the documented "off". See
// docs/runbooks/feature-flags.md.
export const FLAG_PARAMETER_NAME_PREFIX = '/ndn/flags/';
