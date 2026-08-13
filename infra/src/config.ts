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

// Requested via `aws acm request-certificate` (region us-east-1, required
// for CloudFront) against the ndn-prod account; validated via a DNS CNAME
// added to the nourishthenerve.com hosted zone in 803129122420.
export const CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:357601815388:certificate/b1f9e01e-ab10-43b8-944a-6c0ccfffacb5';

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
export const MONITORED_LOG_GROUP_NAMES = ['/ndn/health-function', '/ndn/smoke-test-function'];
