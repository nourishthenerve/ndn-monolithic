// TASK 3.2.1: the deployed Lambda entry for POST /patients/{id}/diagnosis
// and POST /patients/{id}/care-plan (infra/src/data-stack.ts) — same split
// every other endpoint uses: clinical-record.ts is SDK-free and
// unit-testable, this file wires the real DynamoDB-backed repositories
// together.
import type { Patient } from '@ndn/shared-types';

import { ClinicalRecordRepository } from './clinical-record-repository.js';
import { createClinicalRecordHandler } from './clinical-record.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoClinicalRecordStore, DynamoStore } from './dynamo-store.js';
import { PatientRepository } from './patient-repository.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
const audit = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

const patients = new PatientRepository(
  new DynamoStore<Patient>({
    tableName,
    keys: { pk: (id: string) => `PAT#${id}`, sk: () => 'PROFILE' },
  }),
  audit,
  systemClock,
);

const diagnosis = new ClinicalRecordRepository(
  new DynamoClinicalRecordStore({ tableName, kind: 'diagnosis' }),
  audit,
  systemClock,
  'diagnosis',
);

const carePlan = new ClinicalRecordRepository(
  new DynamoClinicalRecordStore({ tableName, kind: 'care-plan' }),
  audit,
  systemClock,
  'care-plan',
);

export const handler = createClinicalRecordHandler({ patients, diagnosis, carePlan, flags });
