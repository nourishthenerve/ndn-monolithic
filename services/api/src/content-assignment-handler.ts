// TASK 3.5.1: the deployed Lambda entry for POST /patients/{id}/content
// and GET /patients/{id}/content (infra/src/data-stack.ts) — same split
// every other endpoint uses: content-assignment.ts is SDK-free and
// unit-testable, this file wires the real DynamoDB-backed repositories
// together.

import { systemClock } from './clock.js';
import { ContentAssignmentRepository } from './content-assignment-repository.js';
import { createContentAssignmentHandler } from './content-assignment.js';
import { ContentRepository } from './content-repository.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import {
  createPatientProfileStore,
  DynamoContentAssignmentStore,
  DynamoContentStore,
} from './dynamo-store.js';
import { PatientRepository } from './patient-repository.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
const audit = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const patients = new PatientRepository(
  createPatientProfileStore(tableName),
  audit,
  systemClock,
);

const content = new ContentRepository(new DynamoContentStore({ tableName }), audit, systemClock);

const assignments = new ContentAssignmentRepository(
  new DynamoContentAssignmentStore({ tableName }),
  content,
  audit,
  systemClock,
);

export const handler = createContentAssignmentHandler({ patients, assignments, flags });
