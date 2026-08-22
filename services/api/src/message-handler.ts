// TASK 3.6.1: the deployed Lambda entry for POST /patients/{id}/messages
// and GET /patients/{id}/messages (infra/src/data-stack.ts). Same split
// every other endpoint uses: message.ts is SDK-free and unit-testable,
// this file wires the real DynamoDB-backed repositories, the real
// Notifier, and one Cognito call — the identical `AdminGetUser` read
// against the clinician pool `assignment-handler.ts` already established
// for the same reason: resolving an assigned clinician's email for a
// notification.
import { AdminGetUserCommand, CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import type { Patient } from '@ndn/shared-types';

import type { AdminGetClinicianEmailPort } from './assignment.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoDeliveryLog } from './dynamo-notification-log.js';
import { DynamoMessageStore, DynamoStore } from './dynamo-store.js';
import { MessageRepository } from './message-repository.js';
import {
  MESSAGE_RATE_LIMIT_PER_PRINCIPAL,
  MESSAGE_RATE_LIMIT_WINDOW_MS,
  createMessageHandler,
} from './message.js';
import { createNotifier } from './notifications.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
import { createSesGenericEmailSender } from './ses.js';
import { InMemorySmsFlagReader } from './sms-flags.js';
import { createAwsEndUserMessagingSmsProvider } from './sms-provider.js';
import { InMemorySpendCounterStore } from './sms-spend-cap.js';
import { createSmsSender } from './sms.js';
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

const messages = new MessageRepository(new DynamoMessageStore({ tableName }), audit, systemClock);

// One rate limiter per warm Lambda container — resets on cold start, the
// same accepted limitation contact-form-handler.ts's own comment names:
// this feature's volume (a signed-in patient/clinician's own conversation)
// doesn't justify a persistent counter the way TASK 3.4.3's real SMS spend
// cap did.
const rateLimiter: RateLimiter = new InMemoryRateLimiter({
  clock: systemClock,
  limit: MESSAGE_RATE_LIMIT_PER_PRINCIPAL,
  windowMs: MESSAGE_RATE_LIMIT_WINDOW_MS,
});

// The same shape assignment-handler.ts/clinician-admin-handler.ts already
// wire — `newMessage` is never `smsEligible` (packages/i18n/src/
// notifications/index.ts), so the SMS path below is wired only to satisfy
// `NotifierDeps`'s type; `InMemorySmsFlagReader`'s default
// (`enabled: false`) means it could not send even if somehow reached.
const notifier = createNotifier({
  sendEmail: createSesGenericEmailSender({
    fromAddress: process.env.MESSAGE_FROM_EMAIL ?? 'noreply@nourishthenerve.com',
    configurationSetName: process.env.SES_CONFIGURATION_SET_NAME,
  }),
  sendSms: createSmsSender({
    flags: new InMemorySmsFlagReader(),
    rateLimiter: new InMemoryRateLimiter({ clock: systemClock, limit: 0, windowMs: 3_600_000 }),
    spendCounter: new InMemorySpendCounterStore(),
    provider: createAwsEndUserMessagingSmsProvider({
      originationIdentity: process.env.SMS_ORIGINATION_IDENTITY ?? '',
    }),
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

export const handler = createMessageHandler({
  patients,
  messages,
  flags,
  rateLimiter,
  notifier,
  getClinicianEmail,
});
