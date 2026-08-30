// TASK 2.5.1: the deployed Lambda entry for the assignment routes
// (infra/src/data-stack.ts). Same split every other endpoint uses —
// assignment.ts is SDK-free and unit-testable, this file is the only
// place that wires the real DynamoDB-backed stores.
//
// D-32 (2026-08-30): the Notifier/SES wiring this file used to construct
// for TASK 2.5.2's reassignment notice — and the one Cognito `AdminGetUser`
// call that resolved a clinician's email for it — are deleted along with
// the notice itself. This function now touches nothing outside DynamoDB.
import { AssignmentRepository } from './assignment-repository.js';
import { createAssignmentHandler } from './assignment.js';
import { ClinicianRepository } from './clinician-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoAssignmentStore, DynamoClinicianStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const clinicians = new ClinicianRepository(
  new DynamoClinicianStore({ tableName: process.env.CLINICIAN_TABLE_NAME ?? '' }),
  auditLog,
  systemClock,
);

const repository = new AssignmentRepository(
  new DynamoAssignmentStore({ tableName: process.env.PRINCIPAL_TABLE_NAME ?? '' }),
  clinicians,
  auditLog,
  systemClock,
);

export const handler = createAssignmentHandler({ repository, flags });
