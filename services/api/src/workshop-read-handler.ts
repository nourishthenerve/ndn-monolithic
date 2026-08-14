// TASK 1.5.1: the deployed Lambda entry for GET /workshops
// (infra/src/data-stack.ts) — same split as content-read-handler.ts: that
// file is SDK-free and unit-testable, this one is the only place that
// wires the real DynamoDB-backed store together.
import { InMemoryAuditLog } from './audit.js';
import { systemClock } from './clock.js';
import { DynamoWorkshopStore } from './dynamo-store.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import { createWorkshopReadHandler, WorkshopRepository } from './workshop-repository.js';

// No SSM-backed FlagSource exists yet — same documented gap every other
// *-read-handler.ts in this repo carries. An InMemoryFlagSource that
// nothing ever sets keeps `workshops.enabled` permanently off in
// production until one is built.
const flags = new CachedFlagReader({
  source: new InMemoryFlagSource(),
  clock: systemClock,
  ttlMs: FLAG_CACHE_TTL_MS,
});

const workshopStore = new DynamoWorkshopStore({
  tableName: process.env.WORKSHOP_TABLE_NAME ?? '',
});

// This handler never calls WorkshopRepository.create() (it's read-only —
// see workshop-repository.ts's createWorkshopReadHandler), so the audit
// writer below is never exercised; InMemoryAuditLog is enough to satisfy
// WorkshopRepository's constructor without standing up a real audit sink.
const repository = new WorkshopRepository(workshopStore, new InMemoryAuditLog(), systemClock);

export const handler = createWorkshopReadHandler({ repository, flags });
