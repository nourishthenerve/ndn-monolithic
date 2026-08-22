// TASK 1.4.2: the deployed Lambda entry for GET /testimonials,
// POST /testimonials/{id}/publish, POST /testimonials/{id}/reject
// (infra/src/data-stack.ts) — same split as content-authoring-handler.ts:
// testimonial-moderation.ts is SDK-free and unit-testable, this file is the
// only place that resolves the real `ADMIN_API_TOKEN` secret (SSM
// SecureString, D-14, the same one content-authoring-handler.ts resolves)
// and wires the real DynamoDB-backed store together.
import { createAdminTokenResolver } from './admin-token.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoTestimonialStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createTestimonialModerationHandler } from './testimonial-moderation.js';
import { TestimonialRepository } from './testimonial-repository.js';

// TASK 2.1.3: the cold-start-cached SSM read that used to sit here, in
// three copies across this repo, now lives in admin-token.ts. Same
// behaviour, one implementation.
const getAdminToken = createAdminTokenResolver();

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

const testimonialStore = new DynamoTestimonialStore({
  tableName: process.env.TESTIMONIAL_TABLE_NAME ?? '',
});

// TASK 2.1.3: the durable audit sink. `AUDIT_TABLE_NAME` is the same table
// every store above writes to (infra/src/data-stack.ts sets all of them to
// NdnDataStack's table name) — named separately because the audit
// partition is the one this function's IAM grant is reasoned about
// independently of.
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new TestimonialRepository(testimonialStore, auditLog, systemClock);

export const handler = createTestimonialModerationHandler({ repository, flags, getAdminToken });
