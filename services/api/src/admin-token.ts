// The `ADMIN_API_TOKEN` resolver (SSM SecureString, D-14), in one place.
//
// TASK 1.3.2 wrote this cold-start cache in content-authoring-handler.ts;
// 1.4.2 and 1.5.1 copied it verbatim into their own wiring files. TASK
// 2.1.3 needs the same secret for a fourth endpoint, and a fourth copy of
// a secret-resolution routine is not a thing to add — so the three
// existing copies collapse onto this one. Behaviour is unchanged, and the
// reasoning that shaped it is preserved below.
//
// The parameter itself is created out-of-band (`aws ssm put-parameter
// --type SecureString`), the same convention infra/src/config.ts's
// CERTIFICATE_ARN documents for the ACM certificate — committing a secret
// value through CDK/CloudFormation state is exactly what SecureString
// exists to avoid. See docs/runbooks/content-authoring.md.
//
// Retired by TASK 2.5.4, along with the bearer gate it feeds
// (admin-auth.ts).
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

// Mirrors infra/src/config.ts's ADMIN_API_TOKEN_PARAMETER_NAME — that
// constant is what data-stack.ts actually sets this env var to at deploy
// time; the literal here is only a local-dev/test fallback (services/api
// doesn't import infra/, the same boundary content-read-handler.ts's
// CONTENT_TABLE_NAME respects).
const DEFAULT_PARAMETER_NAME = '/ndn/admin-api-token';

export interface AdminTokenResolverOptions {
  readonly parameterName?: string;
  readonly client?: SSMClient;
}

/**
 * Resolved once per cold start and reused for the execution environment's
 * lifetime — same "avoid a network round trip on every request" rationale
 * as flags.ts's CachedFlagReader, but with no TTL: rotating this token is a
 * redeploy (a fresh cold start reads the new SSM value), not a live-rotation
 * feature. A *failed* SSM read is never cached — left as `undefined` so the
 * next request retries, rather than a transient SSM blip wedging this warm
 * container into rejecting every request until it's recycled.
 */
export function createAdminTokenResolver(
  options: AdminTokenResolverOptions = {},
): () => Promise<string> {
  const parameterName =
    options.parameterName ?? process.env.ADMIN_TOKEN_PARAMETER_NAME ?? DEFAULT_PARAMETER_NAME;
  const client = options.client ?? new SSMClient({});
  let cachedTokenPromise: Promise<string> | undefined;

  return () => {
    cachedTokenPromise ??= client
      .send(new GetParameterCommand({ Name: parameterName, WithDecryption: true }))
      .then((result) => {
        const value = result.Parameter?.Value;
        if (!value) {
          throw new Error(`SSM parameter ${parameterName} has no value`);
        }
        return value;
      })
      .catch((error: unknown) => {
        cachedTokenPromise = undefined;
        throw error;
      });
    return cachedTokenPromise;
  };
}
