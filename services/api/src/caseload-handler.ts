// TASK 2.5.3: the deployed Lambda entry for `GET /caseload`
// (infra/src/data-stack.ts). Same split every other endpoint uses —
// caseload.ts is SDK-free and unit-testable, this file is the only place
// that wires the real GSI3-backed store.
import { CaseloadRepository } from './caseload-repository.js';
import { createCaseloadHandler } from './caseload.js';
import { ClinicianRepository } from './clinician-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoCaseloadStore, DynamoClinicianStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const clinicians = new ClinicianRepository(
  new DynamoClinicianStore({ tableName: process.env.CLINICIAN_TABLE_NAME ?? '' }),
  new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' }),
  systemClock,
);

const repository = new CaseloadRepository(
  new DynamoCaseloadStore({ tableName: process.env.PRINCIPAL_TABLE_NAME ?? '' }),
  clinicians,
);

export const handler = createCaseloadHandler({ repository, flags });
