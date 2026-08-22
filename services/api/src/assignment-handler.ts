// TASK 2.5.1: the deployed Lambda entry for the assignment routes
// (infra/src/data-stack.ts). Same split every other endpoint uses —
// assignment.ts is SDK-free and unit-testable, this file is the only
// place that wires the real DynamoDB-backed stores and the real Notifier.
//
// TASK 2.5.2 adds one Cognito call — `AdminGetUser` against the clinician
// pool, to resolve an email for the reassignment notice to both
// clinicians. Read-only, and the only Cognito grant this function needs;
// it never creates, disables or enables a clinician user (that's
// clinician-admin-handler.ts's job).
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';

import { AssignmentRepository } from './assignment-repository.js';
import type { AdminGetClinicianEmailPort } from './assignment.js';
import { createAssignmentHandler } from './assignment.js';
import { ClinicianRepository } from './clinician-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoDeliveryLog } from './dynamo-notification-log.js';
import { DynamoAssignmentStore, DynamoClinicianStore } from './dynamo-store.js';
import { createNotifier } from './notifications.js';
import { createSesGenericEmailSender } from './ses.js';
import { InMemorySmsFlagReader } from './sms-flags.js';
import { InMemoryRateLimiter } from './sms-rate-limiter.js';
import { InMemorySpendCounterStore } from './sms-spend-cap.js';
import { createSmsSender } from './sms.js';
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

// Same shape clinician-admin-handler.ts wires — neither `patientApproved`
// nor `patientDeclined` is ever `smsEligible`
// (packages/i18n/src/notifications/index.ts), so the SMS path below is
// wired only to satisfy `NotifierDeps`'s type; `InMemorySmsFlagReader`'s
// default (`enabled: false`) means it could not send even if somehow
// reached.
const notifier = createNotifier({
  sendEmail: createSesGenericEmailSender({
    fromAddress: process.env.ASSIGNMENT_FROM_EMAIL ?? 'noreply@nourishthenerve.com',
    configurationSetName: process.env.SES_CONFIGURATION_SET_NAME,
  }),
  sendSms: createSmsSender({
    flags: new InMemorySmsFlagReader(),
    rateLimiter: new InMemoryRateLimiter({ clock: systemClock, limit: 0, windowMs: 3_600_000 }),
    spendCounter: new InMemorySpendCounterStore(),
    clock: systemClock,
  }),
  log: new DynamoDeliveryLog({ tableName: process.env.NOTIFICATION_TABLE_NAME ?? '' }),
  clock: systemClock,
});

const cognitoClient = new CognitoIdentityProviderClient({});
const clinicianUserPoolId = process.env.CLINICIAN_USER_POOL_ID ?? '';

const getClinicianEmail: AdminGetClinicianEmailPort = {
  async getEmail(clinicianId) {
    const response = await cognitoClient.send(
      new AdminGetUserCommand({ UserPoolId: clinicianUserPoolId, Username: clinicianId }),
    );
    return response.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value;
  },
};

export const handler = createAssignmentHandler({ repository, flags, notifier, getClinicianEmail });
