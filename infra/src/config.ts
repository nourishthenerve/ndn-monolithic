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
  // TASK 2.2.4: one call per sign-in, refresh or sign-out — a handful of
  // lines per patient per day at most, and behind a default-off flag until
  // the account pages open. Displacing nothing, for the same reason.
  '/ndn/auth-token-function',
  '/ndn/site-deployment',
  // TASK 2.4.1: one principal clinician, acting rarely (inviting or
  // deactivating a colleague), behind a default-off flag. Displacing
  // nothing — smaller volume than every function already in the
  // monitored ten, and smaller than most already on this list.
  '/ndn/clinician-admin-function',
  // TASK 2.5.1: one principal clinician approving or declining a patient
  // at a time, behind a default-off flag. Displacing nothing — the same
  // low-volume reasoning as the clinician-admin function just above.
  '/ndn/assignment-function',
  // TASK 2.5.3: one principal clinician browsing the cross-caseload view
  // occasionally, behind a default-off flag. Displacing nothing — the
  // smallest volume of any function in the estate: reads only, one person.
  '/ndn/caseload-function',
  // TASK 3.1.1: a patient's own profile read/update, behind a default-off
  // flag. Bounded by patient count, the same low-volume reasoning as
  // clinician-admin/assignment/caseload above. Displacing nothing.
  '/ndn/patient-function',
  // TASK 3.2.1: a clinician authoring successive diagnosis/care-plan
  // versions, behind a default-off flag. The same bounded-by-patient-count
  // reasoning as patient-function above. Displacing nothing.
  '/ndn/clinical-record-function',
  // TASK 3.3.1: a clinician authoring successive assessment-form
  // versions, behind a default-off flag. The same bounded-by-patient-count
  // reasoning as clinical-record-function above. Displacing nothing.
  '/ndn/assessment-function',
  // TASK 3.4.1: scheduling and reading appointments, behind a default-off
  // flag. The same bounded-by-patient-count reasoning as
  // assessment-function above. Displacing nothing.
  '/ndn/appointment-function',
  // TASK 3.4.3: a scheduled sweep, not a per-request function — volume is
  // bounded by appointment count and a fixed rate(15 minutes) cadence,
  // not traffic, the same reasoning every low-volume function above
  // carries. Displacing nothing.
  '/ndn/reminder-sweep-function',
  // TASK 3.5.1: assigning content to a patient and reading the assigned
  // list, behind a default-off flag. The same bounded-by-patient-count
  // reasoning as appointment-function above. Displacing nothing.
  '/ndn/content-assignment-function',
  // TASK 3.6.1: patient<->clinician messaging, behind a default-off flag.
  // The same bounded-by-patient-count reasoning as appointment-function
  // above — one conversation per patient, not open traffic. Displacing
  // nothing.
  '/ndn/message-function',
  // TASK 4.1.1: four functions, not the two the task's own text names
  // (`ws-connect-function`, `ws-disconnect-function`) — `WebSocketLambdaAuthorizer`
  // cannot share `AuthorizerFunction`'s deployed Lambda (see
  // infra/src/ws-authorizer.ts's header: the two response shapes cannot
  // share one function), so this task also deploys `WsAuthorizerFunction`,
  // and `$default` needs a route to deploy at all, so `WsDefaultFunction`
  // too. All four behind a default-off flag, and all four bounded by
  // "one connect/disconnect per call, on top of appointments the estate
  // already schedules a handful of at a time" — smaller volume than any
  // function already on this list. Displacing nothing.
  '/ndn/ws-authorizer-function',
  '/ndn/ws-connect-function',
  '/ndn/ws-disconnect-function',
  '/ndn/ws-default-function',
  // TASK 4.4.1: one credential-issuance call per retry attempt, bounded
  // by the same low call-volume every prior video function on this list
  // already is. Displacing nothing.
  '/ndn/turn-credentials-function',
  // D-22: a fixed rate(1 day) schedule — one invocation, one log line, per
  // day, the lowest and most predictable volume of any function in the
  // estate. The same "scheduled, not traffic-driven" reasoning
  // reminder-sweep-function above already carries. Displacing nothing.
  '/ndn/backup-export-function',
];

// TASK 3.4.3 (ADR-0008): the leased origination identity (a UK long code
// or sender ID) `sms-provider.ts`'s own header names as "not a secret;
// recorded as a config.ts constant once it exists." It does not exist
// yet — provisioning a real one in AWS End User Messaging is a manual,
// recurring-cost AWS console step (business verification, an ongoing
// leasing fee), the same category of out-of-band action
// `CERTIFICATE_ARN`'s own DNS validation and `TURNSTILE_SECRET_PARAMETER_NAME`'s
// own account signup are — not something CDK can provision, and not
// something this task does on its own authority. Left empty rather than
// invented: `reminder-sweep-handler.ts` still deploys and every guard in
// the SMS send chain (`sms.ts`) still runs correctly against an empty
// identity — the provider call itself fails (`ProviderError`), and
// `notifications.ts`'s own degrade-to-email path is exactly what R-01's
// "never silently drop a reminder" already requires for that case. See
// docs/runbooks/appointment-reminders.md for the provisioning step this
// leaves as the site owner's own action.
export const SMS_ORIGINATION_IDENTITY = '';

// TASK 1.4.1: the SSM SecureString holding the Cloudflare Turnstile secret
// key (D-14) — same out-of-band `aws ssm put-parameter --type SecureString`
// convention CERTIFICATE_ARN documents above; a Turnstile account/widget is
// a manual step for the site owner (docs/runbooks/contact-form.md), not
// something CDK can provision. Shared by
// web-stack.ts (grants ssm:GetParameter and sets the Lambda's
// TURNSTILE_SECRET_PARAMETER_NAME env var) and contact-form-handler.ts's
// own fallback default.
export const TURNSTILE_SECRET_PARAMETER_NAME = '/ndn/turnstile-secret-key';

// TASK 4.4.1 (D-12, ADR-0006): the Cloudflare Realtime TURN key id —
// which of the account's keys `turn-credentials.ts` mints credentials
// against. Not secret on its own (it only names a key, the API token
// below is what authorises minting against it), but left empty rather
// than invented: a Cloudflare Calls/Realtime TURN key is a manual
// dashboard step for the site owner, the same "not something CDK can
// provision" category CERTIFICATE_ARN/TURNSTILE_SECRET_PARAMETER_NAME/
// SMS_ORIGINATION_IDENTITY above already document.
// `turn-credentials-handler.ts` still deploys and every guard in the
// issuance chain still runs correctly against an empty key id — the
// provider call itself fails (`PROVIDER_ERROR`), and a denied credential
// request degrades to TASK 4.3.3's own STUN-only terminal path, never a
// hang. See docs/runbooks/video-calls.md for the provisioning step this
// leaves as the site owner's own action.
export const CLOUDFLARE_TURN_KEY_ID = '';

// TASK 4.4.1: the SSM SecureString holding the matching Cloudflare TURN
// API token (D-14) — same out-of-band `aws ssm put-parameter --type
// SecureString` convention TURNSTILE_SECRET_PARAMETER_NAME documents.
export const CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME = '/ndn/cloudflare-turn-api-token';

// TASK 4.4.2 (R-03): the custom metric `services/api/src/ws-relay-handler.ts`
// emits per TURN-assisted call — mirrored there as literal strings
// (services/api and infra share no runtime package for this value, the
// same "mirrors infra/src/config.ts" convention `contact-form-handler.ts`
// already documents for a secret parameter name, applied here to a
// metric name instead).
export const TURN_RELAY_METRIC_NAMESPACE = 'Ndn/Video';
export const TURN_RELAY_METRIC_NAME = 'EstimatedTurnRelayGB';

// An early-warning threshold, not the hard cap — TASK 4.4.1's own
// concurrent-relay cap is that, enforced before a credential is ever
// issued. Half of Cloudflare's re-verified 1,000 GB/month TURN free tier
// (`03-cost-model.md`), expressed as a daily rate so a one-day CloudWatch
// alarm period (this stack's own existing convention, `LogIngestionVolumeAlarm`)
// can watch it: 500 GB ÷ 30 days ≈ 16.7, rounded up to 17 — one sustained
// day at this rate would, on its own, consume the entire month's early-
// warning margin, well ahead of the real 1,000 GB ceiling.
export const TURN_RELAY_ALARM_THRESHOLD_GB_PER_DAY = 17;

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

// TASK 5.1.1: the load-test stack's own fixed ids/label (bin/app.ts) —
// fixed rather than a generated suffix like PR_STACK_ID_PREFIX's, because
// exactly one load-test copy exists at a time (docs/runbooks/
// load-testing.md), never several concurrently the way open PRs can be.
export const LOAD_TEST_DATA_STACK_ID = 'NdnLoadTestDataStack';
export const LOAD_TEST_WEB_STACK_ID = 'NdnLoadTestWebStack';
export const LOAD_TEST_LABEL = 'load-test';

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
export const AUTH_CALLBACK_URL = `${SITE_ORIGIN}/en/account/callback`;
export const AUTH_SIGN_OUT_URL = `${SITE_ORIGIN}/`;

// TASK 2.2.4: the Cognito-hosted sign-in domains. Globally unique per
// region across all AWS accounts, which is why they carry the project
// prefix; `<prefix>.auth.eu-west-2.amazoncognito.com` is where a patient
// enters their one-time code and a clinician their password and TOTP.
//
// A Cognito prefix domain rather than a custom one: a custom domain needs
// its own us-east-1 certificate and a DNS record in the hosted zone that
// lives in account 803129122420 (docs/runbooks/iac-baseline.md) — a manual
// cross-account step, for cosmetics on a page a patient sees for seconds.
export const PATIENT_USER_POOL_DOMAIN_PREFIX = 'ndn-patients';
export const CLINICIAN_USER_POOL_DOMAIN_PREFIX = 'ndn-clinicians';

/** The `/oauth2/*` base for a pool's hosted domain — where `authorize`, `token` and `revoke` live. */
export function userPoolOAuthBaseUrl(domainPrefix: string): string {
  return `https://${domainPrefix}.auth.${REGION}.amazoncognito.com`;
}
