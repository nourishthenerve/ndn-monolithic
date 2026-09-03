// The deployed Lambda entry for `GET /testimonials` (infra/src/data-stack.ts)
// — same split as every other handler here: testimonial-read.ts is SDK-free
// and unit-testable, this file wires the real DynamoDB-backed store.
//
// 2026-09-02: renamed from `testimonial-moderation-handler.ts` along with
// the module it wires. It needs no flag reader and no audit writer any
// more, because the three routes that used both are gone — this function
// now reads published rows and returns a projection of them, and that is
// all it can do.
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoTestimonialStore } from './dynamo-store.js';
import { createTestimonialReadHandler } from './testimonial-read.js';
import { TestimonialRepository } from './testimonial-repository.js';

const testimonialStore = new DynamoTestimonialStore({
  tableName: process.env.TESTIMONIAL_TABLE_NAME ?? '',
});

// The repository takes an audit writer because every repository does. This
// one is only ever asked to read, so nothing reaches it — but it is given
// the same real sink rather than a stub, so a future write cannot go
// unrecorded by accident.
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new TestimonialRepository(testimonialStore, auditLog, systemClock);

export const handler = createTestimonialReadHandler({ repository });
