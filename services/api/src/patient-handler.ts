// TASK 3.1.1: the deployed Lambda entry for GET/PATCH /patients/{id}
// (infra/src/data-stack.ts) — same split every other endpoint uses:
// patient.ts is SDK-free and unit-testable, this file wires the real
// DynamoDB-backed repository together. `DynamoStore<Patient>` (generic,
// dynamo-store.ts) rather than a bespoke store — `post-confirmation-handler.ts`
// already wires the identical `PAT#<id>` / `PROFILE` key shape this way.
import type { Patient } from '@ndn/shared-types';

import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoStore } from './dynamo-store.js';
import { PatientRepository } from './patient-repository.js';
import { createPatientHandler } from './patient.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';

const repository = new PatientRepository(
  new DynamoStore<Patient>({
    tableName,
    keys: { pk: (id: string) => `PAT#${id}`, sk: () => 'PROFILE' },
  }),
  new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' }),
  systemClock,
);

export const handler = createPatientHandler({ repository, flags });
