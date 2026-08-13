// TASK 0.6.3: this whole suite only makes sense pointed at a live,
// just-deployed ephemeral stack — the pr-environment CI job sets
// PR_ENV_BASE_URL to `https://${DistributionDomainName}` right after
// `cdk deploy`. Fail loudly and immediately if it's missing rather than
// letting every test in the suite fail separately with a confusing
// "fetch failed" for an unset URL.
export function getBaseUrl(): string {
  const baseUrl = process.env.PR_ENV_BASE_URL;
  if (!baseUrl) {
    throw new Error(
      'PR_ENV_BASE_URL is not set — this suite must run against a live ephemeral stack, ' +
        'never as part of the ordinary unit/integration test run.',
    );
  }
  return baseUrl;
}
