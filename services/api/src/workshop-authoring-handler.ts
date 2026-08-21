// TASK 1.5.1: the deployed Lambda entry for the workshop authoring routes
// (infra/src/data-stack.ts) — same split as content-authoring-handler.ts:
// that file is SDK-free and unit-testable, this one is the only place that
// resolves the real ADMIN_API_TOKEN secret (SSM SecureString, D-14) and
// wires the real DynamoDB-backed store together. Reuses the same SSM
// parameter content-authoring-handler.ts/testimonial-moderation-handler.ts
// already read — no second admin credential.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { InMemoryAuditLog } from './audit.js';
import { systemClock } from './clock.js';
import { DynamoWorkshopStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createWorkshopAuthoringHandler } from './workshop-authoring.js';
import { WorkshopRepository } from './workshop-repository.js';

// Mirrors infra/src/config.ts's ADMIN_API_TOKEN_PARAMETER_NAME — see
// content-authoring-handler.ts's own comment for why this is only a
// local-dev/test fallback.
const ADMIN_TOKEN_PARAMETER_NAME = process.env.ADMIN_TOKEN_PARAMETER_NAME ?? '/ndn/admin-api-token';

const ssmClient = new SSMClient({});

// Same cold-start caching convention as content-authoring-handler.ts's
// cachedTokenPromise.
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

const workshopStore = new DynamoWorkshopStore({
  tableName: process.env.WORKSHOP_TABLE_NAME ?? '',
});

// This handler's audit writes have nowhere durable to land yet — same
// documented gap content-authoring-handler.ts carries for its own
// InMemoryAuditLog.
const repository = new WorkshopRepository(workshopStore, new InMemoryAuditLog(), systemClock);

export const handler = createWorkshopAuthoringHandler({ repository, flags, getAdminToken });
