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
