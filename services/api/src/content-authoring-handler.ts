// TASK 1.3.2: the deployed Lambda entry for the authoring routes
// (infra/src/data-stack.ts) — same split as content-read-handler.ts: that
// file is SDK-free and unit-testable, this one is the only place that
// resolves the real `ADMIN_API_TOKEN` secret (SSM SecureString, D-14) and
// wires the real DynamoDB-backed store together.
//
// The SSM parameter itself is created out-of-band (`aws ssm put-parameter
// --type SecureString`), the same convention infra/src/config.ts's
// CERTIFICATE_ARN documents for the ACM certificate — committing a secret
// value through CDK/CloudFormation state is exactly what SecureString
// exists to avoid. See docs/runbooks/content-authoring.md.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { InMemoryAuditLog } from './audit.js';
import { systemClock } from './clock.js';
import { createContentAuthoringHandler } from './content-authoring.js';
import { ContentRepository } from './content-repository.js';
import { DynamoContentStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

// Mirrors infra/src/config.ts's ADMIN_API_TOKEN_PARAMETER_NAME — that
// constant is what data-stack.ts actually sets this env var to at deploy
// time; the literal here is only a local-dev/test fallback (services/api
// doesn't import infra/, the same boundary content-read-handler.ts's
// CONTENT_TABLE_NAME respects).
const ADMIN_TOKEN_PARAMETER_NAME = process.env.ADMIN_TOKEN_PARAMETER_NAME ?? '/ndn/admin-api-token';

const ssmClient = new SSMClient({});

// Resolved once per cold start and reused for the execution environment's
// lifetime — same "avoid a network round trip on every request" rationale
// as flags.ts's CachedFlagReader, but with no TTL: rotating this token is a
// redeploy (a fresh cold start reads the new SSM value), not a live-rotation
// feature. A *failed* SSM read is never cached — left as `undefined` so the
// next request retries, rather than a transient SSM blip wedging this warm
// container into rejecting every request until it's recycled.
let cachedTokenPromise: Promise<string> | undefined;

function getAdminToken(): Promise<string> {
  cachedTokenPromise ??= ssmClient
    .send(new GetParameterCommand({ Name: ADMIN_TOKEN_PARAMETER_NAME, WithDecryption: true }))
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${ADMIN_TOKEN_PARAMETER_NAME} has no value`);
      }
      return value;
    })
    .catch((error: unknown) => {
      cachedTokenPromise = undefined;
      throw error;
    });
  return cachedTokenPromise;
}

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

const contentStore = new DynamoContentStore({ tableName: process.env.CONTENT_TABLE_NAME ?? '' });

// This handler's audit writes have nowhere durable to land yet (no audit
// sink is deployed — same gap content-read-handler.ts's own comment notes
// for its unused InMemoryAuditLog), tracked by whichever future task first
// needs a queryable audit trail rather than reproduced here.
const repository = new ContentRepository(contentStore, new InMemoryAuditLog(), systemClock);

export const handler = createContentAuthoringHandler({ repository, flags, getAdminToken });
