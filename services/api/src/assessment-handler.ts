// TASK 3.3.1: the deployed Lambda entry for POST
// /patients/{id}/assessments/{assessmentId} (infra/src/data-stack.ts) —
// same split every other endpoint uses: assessment.ts is SDK-free and
// unit-testable, this file wires the real DynamoDB-backed repositories
// together.

import { AssessmentRepository } from './assessment-repository.js';
import { createAssessmentHandler } from './assessment.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { createPatientProfileStore, DynamoAssessmentStore } from './dynamo-store.js';
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

const assessments = new AssessmentRepository(
  new DynamoAssessmentStore({ tableName }),
  audit,
  systemClock,
);

export const handler = createAssessmentHandler({ patients, assessments, flags });
