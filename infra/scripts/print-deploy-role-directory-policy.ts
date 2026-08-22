// Thin wrapper around guardrails.ts's buildDeployRoleDirectoryPolicyDocument
// — same "logic lives in the package, script is a thin wrapper" split
// print-example-guardrail-policy.ts uses.
//
// This one prints the policy that is *actually applied* to the real
// ndn-deploy role (TASK 2.2.1 step 9), not an illustrative example:
//   npx tsx infra/scripts/print-deploy-role-directory-policy.ts \
//     > infra/src/__fixtures__/guardrails/deploy-role-directory-policy.json
//   aws --profile ndn-prod iam put-role-policy --role-name ndn-deploy \
//     --policy-name DenyDirectoryDestructivePrimitives \
//     --policy-document file://infra/src/__fixtures__/guardrails/deploy-role-directory-policy.json
// guardrails.test.ts's freshness test fails CI if the checked-in file and
// this function ever diverge; CI's oidc-dry-run job proves the *real*
// role's decision on every PR.

import { buildDeployRoleDirectoryPolicyDocument } from '../src/guardrails.js';

console.log(JSON.stringify(buildDeployRoleDirectoryPolicyDocument(), null, 2));
