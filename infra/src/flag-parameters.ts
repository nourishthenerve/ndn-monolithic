// TASK 1.6.2: the IAM half of the SSM-backed feature-flag store
// (services/api/src/ssm-flag-source.ts). Every flag-reading Lambda needs
// the same narrow grant, and nine hand-rolled copies of it is nine places
// for the ARN pattern to drift — this is one, the same reasoning
// log-retention.ts's createLogGroup uses for log groups.
import { Stack } from 'aws-cdk-lib';
import { Effect, PolicyStatement, type IRole } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

import { FLAG_PARAMETER_NAME_PREFIX } from './config.js';

/**
 * Grants `ssm:GetParameter` over the flag prefix only.
 *
 * Scoped to `parameter/ndn/flags/*` — deliberately a wildcard over the
 * prefix rather than one statement per flag name. A flag is created when an
 * operator decides to turn something on; naming them individually here
 * would mean a deploy before every flip, which is precisely the coupling
 * D-23 chose these flags to avoid. The prefix holds nothing secret (plain
 * `String` parameters, no `WithDecryption`), so the wildcard grants read
 * access to booleans and nothing else — it cannot reach
 * `/ndn/admin-api-token`, `/ndn/stripe-secret-key` or any other `/ndn/*`
 * secret, which sit outside the `flags/` segment.
 */
export function grantFlagReads(scope: Construct, role: IRole): void {
  role.addToPrincipalPolicy(
    new PolicyStatement({
      sid: 'ReadFeatureFlags',
      effect: Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        Stack.of(scope).formatArn({
          service: 'ssm',
          resource: 'parameter',
          resourceName: `${FLAG_PARAMETER_NAME_PREFIX.replace(/^\//, '')}*`,
        }),
      ],
    }),
  );
}

/** The env var `ssm-flag-source.ts` reads its prefix from, ready to spread into a function's `environment`. */
export const FLAG_ENVIRONMENT = { FLAG_PARAMETER_NAME_PREFIX } as const;
