// TASK 1.3.2: the deployed Lambda entry for the authoring routes
// (infra/src/data-stack.ts) — same split as content-read-handler.ts: that
// file is SDK-free and unit-testable, this one wires the real
// DynamoDB-backed store together.
//
// TASK 2.5.4: no admin secret to resolve here any more — the route sits
// behind infra's real Lambda authorizer by default (no `authorizer:`
// override in data-stack.ts), and content-authoring.ts reads the
// principal straight off the event.
import { systemClock } from './clock.js';
import { createContentAuthoringHandler } from './content-authoring.js';
import { ContentRepository } from './content-repository.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoContentStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

const contentStore = new DynamoContentStore({ tableName: process.env.CONTENT_TABLE_NAME ?? '' });

// TASK 2.1.3: the durable audit sink. `AUDIT_TABLE_NAME` is the same table
// every store above writes to (infra/src/data-stack.ts sets all of them to
// NdnDataStack's table name) — named separately because the audit
// partition is the one this function's IAM grant is reasoned about
// independently of.
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new ContentRepository(contentStore, auditLog, systemClock);

export const handler = createContentAuthoringHandler({ repository, flags });
