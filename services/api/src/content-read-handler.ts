// TASK 1.3.1: the deployed Lambda entry for GET /content?keyword=
// (infra/src/data-stack.ts). Kept separate from content-repository.ts (SDK-
// free, unit-testable against InMemoryContentStore) so this file is the
// only place that wires the real DynamoDB-backed store together — same
// split as web-stack.ts's health.ts (pure handler) vs. smoke-test.ts (owns
// its own AWS client wiring).
import { systemClock } from './clock.js';
import { ContentRepository, createContentReadHandler } from './content-repository.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoContentStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

// No client option given — DynamoContentStore defaults to a real
// DynamoDBDocumentClient (dynamo-store.ts).
const contentStore = new DynamoContentStore({ tableName: process.env.CONTENT_TABLE_NAME ?? '' });

// TASK 2.1.3: read-only handler — it never calls a repository method that
// writes, so this writer is never exercised. It is the real
// `DynamoAuditLog` rather than an in-memory stand-in anyway: this
// function's role holds no `dynamodb:PutItem` (infra/src/data-stack.ts),
// so if a write path ever did appear here it would fail loudly at IAM
// instead of appending to an array nobody reads.
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const repository = new ContentRepository(contentStore, auditLog, systemClock);

export const handler = createContentReadHandler({ repository, flags });
