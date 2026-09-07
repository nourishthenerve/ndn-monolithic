// 2026-09-07: the deployed Lambda entry for the principal's testimonial
// picks — `GET|PUT /testimonials/curation` (infra/src/data-stack.ts). Same
// split as every other handler: testimonial-curation.ts is SDK-free and
// unit-testable, this file wires the real store, audit sink and flags.
//
// A function of its own rather than two more routes on
// `TestimonialAuthoringFunction`, and the reason is IAM rather than tidiness:
// the authoring function may write a patient's testimonial row and this one
// must never be able to, which is only true if they are different roles.
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoTestimonialStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createTestimonialCurationHandler } from './testimonial-curation.js';
import { TestimonialRepository } from './testimonial-repository.js';

const flags = createSsmFlagReader();

const testimonialStore = new DynamoTestimonialStore({
  tableName: process.env.TESTIMONIAL_TABLE_NAME ?? '',
});

const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new TestimonialRepository(testimonialStore, auditLog, systemClock);

export const handler = createTestimonialCurationHandler({ repository, flags });
