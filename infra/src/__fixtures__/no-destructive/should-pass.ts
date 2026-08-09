// Fixture proving the infra/ Deny-effect allowlist works: this is the one
// shape TASK 0.3.1 step 2 permits an s3:DeleteObject* action string in.
// Run: pnpm lint:no-destructive  (expected: this file contributes zero errors)
// Excluded from the normal `pnpm -r lint` run — see eslint.config.js ignores.
// See docs/plan/05-execution-plan.md TASK 0.3.1 and TASK 0.3.2 (IAM deny guardrails).

export const denyS3ObjectDeletion = {
  effect: 'Deny',
  actions: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
  resources: ['arn:aws:s3:::example-bucket/*'],
};
