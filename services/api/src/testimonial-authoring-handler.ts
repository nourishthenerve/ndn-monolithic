// 2026-09-02: the deployed Lambda entry for a patient's own testimonial —
// `GET|PUT|DELETE /testimonials/mine` (infra/src/data-stack.ts). Same split
// as every other handler: testimonial-authoring.ts is SDK-free and
// unit-testable, this file wires the real store, audit sink and flags.
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoTestimonialStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createTestimonialAuthoringHandler } from './testimonial-authoring.js';
import { TestimonialRepository } from './testimonial-repository.js';

const flags = createSsmFlagReader();

const testimonialStore = new DynamoTestimonialStore({
  tableName: process.env.TESTIMONIAL_TABLE_NAME ?? '',
});

const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new TestimonialRepository(testimonialStore, auditLog, systemClock);

export const handler = createTestimonialAuthoringHandler({ repository, flags });
