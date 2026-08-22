// TASK 0.4.1: checked-in, non-secret deployment constants. The certificate
// ARN points at a certificate requested and DNS-validated manually ahead of
// any CDK deploy — see docs/runbooks/iac-baseline.md for why (the
// nourishthenerve.com hosted zone lives in a different AWS account,
// 803129122420, than this stack deploys to, so CI's ndn-deploy role cannot
// create the validation record itself).
export const ACCOUNT_ID = '357601815388';
export const REGION = 'eu-west-2';

// The hostname this stack has served since TASK 0.4.1, and still its only
// one until the G1 cutover's DNS step runs (TASK 1.6.1). Kept as an alias
// after cutover too, so next. stays a usable staging URL.
// See docs/plan/05-execution-plan.md TASK 0.4.1.
export const DOMAIN_NAME = 'next.nourishthenerve.com';

// TASK 1.6.1: the two hostnames the G1 cutover moves onto this stack's
// distribution. Listing them as alternate domain names is itself
// DNS-invisible — no traffic moves until the cutover runbook's manual DNS
// step repoints apex/www — but the deploy that adds them only succeeds once
// the legacy claim is released, which is a manual AWS-side step in a
// different account (803129122420's `ndn-frontend` Amplify app). Order and
// consequences: docs/runbooks/g1-cutover.md.
export const APEX_DOMAIN_NAME = 'nourishthenerve.com';
export const WWW_DOMAIN_NAME = 'www.nourishthenerve.com';

// TASK 1.6.1 step 5: the canonical public origin, for the one place a Lambda
// has to build an absolute URL back to the site — Stripe Checkout's
// success/cancel redirects. The apex rather than DOMAIN_NAME, matching
// apps/web/src/site-config.ts's siteUrl: `next.` is an alias on the same
// distribution and still serves, but a customer returning from Stripe should
// land on the hostname the site calls canonical.
export const SITE_ORIGIN = `https://${APEX_DOMAIN_NAME}`;

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

// TASK 0.5.2 fix (see docs/runbooks/rollback.md): the log groups whose
// IncomingBytes budget-stack.ts sums into the single log-volume alarm.
// AWS's PutMetricAlarm API rejects any alarm math expression containing a
// SEARCH() (confirmed against the real API, not just CDK synth), so the
// groups have to be named one by one; a dynamically-discovered,
// zero-maintenance version isn't achievable without a separate
// metric-publishing Lambda, which is more infrastructure than this
// £0.00-cost guard has earned so far.
//
// **Ten is a hard ceiling, not a style preference.** PutMetricAlarm answers
// an eleventh metric with `ValidationError: Too many metrics in alarm,
// maximum is 10` — probed against the real API in eu-west-2 on 2026-08-21
// (10 metrics + the sum expression: accepted; 13 + the expression:
// rejected), the same way the SEARCH() rejection was found, and for the
// same reason: CDK synth is happy with either. An eleventh entry here
// breaks every deploy, so adding a log group means choosing which one it
// displaces and recording the swap in UNMONITORED_LOG_GROUP_NAMES below.
export const MONITORED_LOG_GROUP_NAMES = [
  '/ndn/health-function',
  '/ndn/smoke-test-function',
  '/ndn/contact-form-function',
  '/ndn/testimonial-submission-function',
  '/ndn/testimonial-moderation-function',
  '/ndn/workshop-checkout-function',
  '/ndn/stripe-webhook-function',
  // Gate G1 §4: the two public GET endpoints were missing from this list
  // and are the two highest-volume groups the moment their flags come on —
  // every blog and workshops page view hits one of them. Added ahead of
  // that, with media-upload (the largest per-request payloads) taking the
  // last free slot.
  '/ndn/content-read-function',
  '/ndn/workshop-read-function',
  // TASK 2.2.2 takes the last slot, **displacing `/ndn/media-upload-function`**
  // to the unmonitored list below. The swap is recorded here, as this
  // file's own instruction above requires, and the reasoning is a
  // comparison rather than a preference: the authorizer sits on the path
  // of every authenticated request in the system, and media upload is an
  // admin-gated action a clinician performs when publishing a workshop
  // image. If either one is going to run away, it is not the one a human
  // triggers by hand.
  '/ndn/authorizer-function',
];

// The other side of that ceiling, kept explicit so the gap is a recorded
// decision rather than an oversight — log-retention.test.ts asserts that
// these two lists together account for every /ndn/* log group the app
// synthesizes, so a new createLogGroup() call fails the build until someone
// puts it in one list or the other.
//
// These four are the lowest-volume groups in the estate — site-deployment
// writes ~4 KB per deploy, and the two authoring handlers only when a
// clinician publishes — so they are what a 10-slot budget leaves out.
// (Admin-gated is not itself the criterion: testimonial-moderation keeps
// the slot it has held since this alarm was built.) Their bytes still
// expire on the same 14-day retention; they are simply not summed into the
// alarm, which therefore under-reports total ingestion slightly rather
// than missing a plausible runaway.
//
// TASK 2.1.3 adds `/ndn/audit-read-function` here rather than displacing
// anything from the monitored ten, and the required "which list, and what
// does it displace" answer is: this list, displacing nothing. One
// principal clinician reading a day of audit rows, behind a default-off
// flag, is the smallest log volume any function in this estate can
// produce — smaller than the two authoring handlers already here.
//
// TASK 2.2.2 moves `/ndn/media-upload-function` here — see the note on the
// last entry of the monitored list. It keeps its 14-day retention and its
// bytes still expire; they are simply no longer summed into the alarm.
//
// TASK 2.2.3 adds both of its functions here, displacing nothing. The
// answer to this file's "which list, and what does it displace" question
// is: registration is a once-per-patient act behind a default-off flag, and
// the Post-Confirmation trigger fires exactly once per registration. At
// 509 patients over a year that is a few hundred invocations in total —
// the two smallest log volumes in the estate after site-deployment.
export const UNMONITORED_LOG_GROUP_NAMES = [
  '/ndn/content-authoring-function',
  '/ndn/workshop-authoring-function',
  '/ndn/audit-read-function',
  '/ndn/media-upload-function',
  '/ndn/registration-function',
  '/ndn/post-confirmation-function',
  '/ndn/site-deployment',
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

// The one log group an ephemeral PR stack writes to but does not own.
//
// Gate G1 §4's fix gave `BucketDeployment`'s Lambda an explicit log group,
// which works for production but not for a stack that gets destroyed: the
// same `cdk destroy` that deletes the group also invokes that Lambda with
// a Delete event, and its logs flush *after* the group is gone, so
// CloudWatch recreates the group — bare, uncapped, outside CloudFormation.
// Observed on PR #48's own run, not theorised: the recreated
// `/ndn/pr-48/site-deployment` carried a creation timestamp **9 seconds
// later than the log events inside it**.
//
// So ephemeral stacks import this shared, long-lived group by name instead
// of creating one each. Nothing per-PR is created, nothing is deleted
// mid-flight, and there is no race to lose. It is created out of band with
// 14-day retention (docs/runbooks/log-retention-volume-control.md) —
// deliberately owned by neither stack, since a CloudFormation resource
// that any PR can race is the exact problem being solved. Production keeps
// its own stack-owned `/ndn/site-deployment`.
export const PR_ENV_SITE_DEPLOYMENT_LOG_GROUP_NAME = '/ndn/pr-env/site-deployment';

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

// TASK 2.2.1 (ADR-0004's two-pool amendment): the two Cognito directories
// and the one browser redirect pair they both trust.
//
// The pool *names* are constants here because they are ours to choose and
// two files need to agree on them (auth-stack.ts creates them,
// docs/runbooks/cognito-user-pools.md's verification commands name them).
export const PATIENT_USER_POOL_NAME = 'ndn-patients';
export const CLINICIAN_USER_POOL_NAME = 'ndn-clinicians';

// TASK 2.2.1 step 8, completed after the first deploy (2026-08-22) — the
// one part of that step that could not be done before it, because Cognito
// generates these and CDK cannot name them. Read from `NdnAuthStack`'s own
// CloudFormation outputs, not from the console:
//
//   aws --profile ndn-prod cloudformation describe-stacks \
//     --stack-name NdnAuthStack --region eu-west-2 \
//     --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
//
// Identifiers, not secrets — the same standing CERTIFICATE_ARN above has.
// A user pool id appears in every OIDC discovery document these pools
// serve and a public app client id is sent to the browser by design;
// treating either as a secret would be theatre. What is *not* here and
// never will be is a client secret: both clients are public
// (`generateSecret: false`, auth-stack.ts).
//
// They are constants rather than a CloudFormation cross-stack import
// because two of the three consumers are not CDK: TASK 2.2.2's authorizer
// takes them as Lambda environment variables, and TASK 2.2.4's browser
// bundle needs them at `astro build` time.
//
// **If a pool is ever rebuilt, these change and every session dies.** That
// is not a reason to avoid recording them; it is the reason the pools are
// `RETAIN` plus deletion protection and the deploy role is denied
// `DeleteUserPool` (docs/runbooks/cognito-user-pools.md).
export const PATIENT_USER_POOL_ID = 'eu-west-2_lMonWXA0b';
export const PATIENT_USER_POOL_CLIENT_ID = '6r45vfhjv9atkq3iojfinr3lda';
export const CLINICIAN_USER_POOL_ID = 'eu-west-2_1SFN2y0Jt';
export const CLINICIAN_USER_POOL_CLIENT_ID = '2dt02jv4lstdvh9fl4cnsqn4gn';

// The two `iss` values TASK 2.2.2 verifies a token against, and the only
// two it may ever accept. Derived from the ids above rather than pasted
// from the stack outputs a second time: an issuer that disagreed with its
// own pool id would be a token-verification bug of exactly the kind this
// authorizer exists to prevent, and deriving it makes that unrepresentable.
// Cognito's own format, unchanged since the service shipped:
// https://cognito-idp.<region>.amazonaws.com/<pool-id>.
export const PATIENT_USER_POOL_ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${PATIENT_USER_POOL_ID}`;
export const CLINICIAN_USER_POOL_ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${CLINICIAN_USER_POOL_ID}`;

// Where Cognito is permitted to send a browser back to. Both are on
// SITE_ORIGIN (the apex) and nowhere else — TASK 2.2.4 puts `/auth/*`
// behind the same CloudFront distribution, so the whole exchange stays
// same-origin and the existing CSP already covers it. `next.` is
// deliberately absent even though it serves the same distribution: a
// second valid redirect target is a second place an authorization code
// can be delivered.
export const AUTH_CALLBACK_URL = `${SITE_ORIGIN}/auth/callback`;
export const AUTH_SIGN_OUT_URL = `${SITE_ORIGIN}/`;
