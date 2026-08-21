// TASK 1.3.1: the deployed Lambda entry for GET /content?keyword=
// (infra/src/data-stack.ts). Kept separate from content-repository.ts (SDK-
// free, unit-testable against InMemoryContentStore) so this file is the
// only place that wires the real DynamoDB-backed store together — same
// split as web-stack.ts's health.ts (pure handler) vs. smoke-test.ts (owns
// its own AWS client wiring).
import { InMemoryAuditLog } from './audit.js';
import { systemClock } from './clock.js';
import { ContentRepository, createContentReadHandler } from './content-repository.js';
import { DynamoContentStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

// TASK 1.6.2: reads /ndn/flags/<name> from SSM and fails closed — see
// ssm-flag-source.ts. Replaces the InMemoryFlagSource nothing ever set.
const flags = createSsmFlagReader();

// No client option given — DynamoContentStore defaults to a real
// DynamoDBDocumentClient (dynamo-store.ts).
const contentStore = new DynamoContentStore({ tableName: process.env.CONTENT_TABLE_NAME ?? '' });

// This handler never calls ContentRepository.create() (it's read-only —
// see content-repository.ts's createContentReadHandler), so the audit
// writer below is never exercised; InMemoryAuditLog is enough to satisfy
// ContentRepository's constructor without standing up a real audit sink.
const repository = new ContentRepository(contentStore, new InMemoryAuditLog(), systemClock);

export const handler = createContentReadHandler({ repository, flags });
