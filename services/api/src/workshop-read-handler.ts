// TASK 1.5.1: the deployed Lambda entry for GET /workshops
// (infra/src/data-stack.ts) — same split as content-read-handler.ts: that
// file is SDK-free and unit-testable, this one is the only place that
// wires the real DynamoDB-backed store together.
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoWorkshopStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createWorkshopReadHandler, WorkshopRepository } from './workshop-repository.js';

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

const workshopStore = new DynamoWorkshopStore({
  tableName: process.env.WORKSHOP_TABLE_NAME ?? '',
});

// TASK 2.1.3: read-only handler — it never calls a repository method that
// writes, so this writer is never exercised. It is the real
// `DynamoAuditLog` rather than an in-memory stand-in anyway: this
// function's role holds no `dynamodb:PutItem` (infra/src/data-stack.ts),
// so if a write path ever did appear here it would fail loudly at IAM
// instead of appending to an array nobody reads.
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new WorkshopRepository(workshopStore, auditLog, systemClock);

export const handler = createWorkshopReadHandler({ repository, flags });
