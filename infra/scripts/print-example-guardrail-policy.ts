// Thin wrapper around guardrails.ts's buildExampleRuntimePolicyDocument —
// the logic lives there and is unit-tested in guardrails.test.ts (same
// "logic lives in the package, script is a thin wrapper" split TASK 0.3.1
// used for scripts/check-no-disable-comments.mjs).
//
// Regenerate infra/src/__fixtures__/guardrails/example-runtime-policy.json
// with this whenever guardrails.ts's Deny statement shape changes:
//   npx tsx infra/scripts/print-example-guardrail-policy.ts \
//     > infra/src/__fixtures__/guardrails/example-runtime-policy.json
// guardrails.test.ts's freshness test fails CI if you forget.

import { buildExampleRuntimePolicyDocument } from '../src/guardrails.js';

console.log(JSON.stringify(buildExampleRuntimePolicyDocument(), null, 2));
