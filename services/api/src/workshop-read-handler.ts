// TASK 1.5.1: the deployed Lambda entry for GET /workshops
// (infra/src/data-stack.ts) — same split as content-read-handler.ts: that
// file is SDK-free and unit-testable, this one is the only place that
// wires the real DynamoDB-backed store together.
import { InMemoryAuditLog } from './audit.js';
import { systemClock } from './clock.js';
import { DynamoWorkshopStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createWorkshopReadHandler, WorkshopRepository } from './workshop-repository.js';

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

const workshopStore = new DynamoWorkshopStore({
  tableName: process.env.WORKSHOP_TABLE_NAME ?? '',
});

// This handler never calls WorkshopRepository.create() (it's read-only —
// see workshop-repository.ts's createWorkshopReadHandler), so the audit
// writer below is never exercised; InMemoryAuditLog is enough to satisfy
// WorkshopRepository's constructor without standing up a real audit sink.
const repository = new WorkshopRepository(workshopStore, new InMemoryAuditLog(), systemClock);

export const handler = createWorkshopReadHandler({ repository, flags });
