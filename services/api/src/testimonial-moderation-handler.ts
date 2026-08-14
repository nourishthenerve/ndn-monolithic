// TASK 1.4.2: the deployed Lambda entry for GET /testimonials,
// POST /testimonials/{id}/publish, POST /testimonials/{id}/reject
// (infra/src/data-stack.ts) — same split as content-authoring-handler.ts:
// testimonial-moderation.ts is SDK-free and unit-testable, this file is the
// only place that resolves the real `ADMIN_API_TOKEN` secret (SSM
// SecureString, D-14, the same one content-authoring-handler.ts resolves)
// and wires the real DynamoDB-backed store together.
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import { InMemoryAuditLog } from './audit.js';
import { systemClock } from './clock.js';
import { DynamoTestimonialStore } from './dynamo-store.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import { createTestimonialModerationHandler } from './testimonial-moderation.js';
import { TestimonialRepository } from './testimonial-repository.js';

// Mirrors infra/src/config.ts's ADMIN_API_TOKEN_PARAMETER_NAME — the same
// admin token content-authoring-handler.ts resolves, reused rather than a
// second secret.
const ADMIN_TOKEN_PARAMETER_NAME = process.env.ADMIN_TOKEN_PARAMETER_NAME ?? '/ndn/admin-api-token';

const ssmClient = new SSMClient({});

// Same cold-start caching convention as content-authoring-handler.ts's
// cachedTokenPromise (a failed read is never cached).
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

// No SSM-backed FlagSource exists yet — same documented gap every other
// *-handler.ts in this repo carries. An InMemoryFlagSource that nothing
// ever sets keeps testimonials.moderationQueue.enabled permanently off in
// production until one is built.
const flags = new CachedFlagReader({
  source: new InMemoryFlagSource(),
  clock: systemClock,
  ttlMs: FLAG_CACHE_TTL_MS,
});

const testimonialStore = new DynamoTestimonialStore({
  tableName: process.env.TESTIMONIAL_TABLE_NAME ?? '',
});

// This handler's audit writes have nowhere durable to land yet — same
// documented gap content-authoring-handler.ts carries for its own
// InMemoryAuditLog.
const repository = new TestimonialRepository(testimonialStore, new InMemoryAuditLog(), systemClock);

export const handler = createTestimonialModerationHandler({ repository, flags, getAdminToken });
