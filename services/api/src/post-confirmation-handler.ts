// TASK 2.2.3: the deployed Lambda entry for the patient pool's
// Post-Confirmation trigger (infra/src/auth-stack.ts attaches it;
// infra/src/data-stack.ts owns the function, because everything it writes
// is on that stack's table). Thin wiring only — the logic and its
// idempotence are post-confirmation.ts, tested without AWS.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { Patient } from '@ndn/shared-types';

import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoIntakeStore } from './dynamo-intake-store.js';
import { DynamoStore } from './dynamo-store.js';
import { PatientRepository } from './patient-repository.js';
import { createPostConfirmationHandler } from './post-confirmation.js';
import { createRegistrationEmailSender } from './ses-registration.js';

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// `PAT#<sub>` / `PROFILE` — the key shape TASK 2.2.2's authorizer reads
// with one GetItem, which is why the record id and the Cognito sub are the
// same value (see dynamo-principal-directory.ts).
const patients = new PatientRepository(
  new DynamoStore<Patient>({
    tableName,
    client,
    keys: { pk: (id: string) => `PAT#${id}`, sk: () => 'PROFILE' },
  }),
  new DynamoAuditLog({ tableName, client }),
  systemClock,
);

export const handler = createPostConfirmationHandler({
  patients,
  intake: new DynamoIntakeStore({ tableName, client }),
  sendConfirmationEmail: createRegistrationEmailSender({
    fromAddress: process.env.REGISTRATION_FROM_EMAIL ?? 'noreply@nourishthenerve.com',
    configurationSetName: process.env.SES_CONFIGURATION_SET_NAME ?? 'ndn-email',
  }),
});
