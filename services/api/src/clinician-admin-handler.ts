// TASK 2.4.1: the deployed Lambda entry for the clinician-admin routes
// (infra/src/data-stack.ts). Same split every other endpoint uses —
// clinician-admin.ts is SDK-free and unit-testable, this file is the only
// place that wires the real Cognito Admin* calls, the real DynamoDB-backed
// stores, and the real Notifier.
import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

import {
  createClinicianAdminHandler,
  type AdminCreateClinicianPort,
  type AdminDeactivateClinicianPort,
  type AdminReactivateClinicianPort,
} from './clinician-admin.js';
import { ClinicianRepository } from './clinician-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoDeliveryLog } from './dynamo-notification-log.js';
import { DynamoClinicianStore } from './dynamo-store.js';
import { createNotifier } from './notifications.js';
import { createSesGenericEmailSender } from './ses.js';
import { InMemorySmsFlagReader } from './sms-flags.js';
import { createAwsEndUserMessagingSmsProvider } from './sms-provider.js';
import { InMemoryRateLimiter } from './sms-rate-limiter.js';
import { InMemorySpendCounterStore } from './sms-spend-cap.js';
import { createSmsSender } from './sms.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });
const repository = new ClinicianRepository(
  new DynamoClinicianStore({ tableName: process.env.CLINICIAN_TABLE_NAME ?? '' }),
  auditLog,
  systemClock,
);

const cognitoClient = new CognitoIdentityProviderClient({});
const clinicianUserPoolId = process.env.CLINICIAN_USER_POOL_ID ?? '';

const createClinicianUser: AdminCreateClinicianPort = {
  async createUser(email) {
    const response = await cognitoClient.send(
      new AdminCreateUserCommand({
        UserPoolId: clinicianUserPoolId,
        Username: email,
        UserAttributes: [
          { Name: 'email', Value: email },
          // The principal invited this address directly — there is no
          // separate verification step to wait on, unlike a patient's
          // self-serve `SignUp`.
          { Name: 'email_verified', Value: 'true' },
        ],
        // Cognito generates the temporary password and delivers it —
        // clinician-admin.ts's header explains why this is not routed
        // through the Notifier.
        DesiredDeliveryMediums: ['EMAIL'],
      }),
    );
    const sub = response.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    if (!sub) {
      throw new Error('AdminCreateUser did not return a sub attribute');
    }
    return sub;
  },
};

// `Username` here is always the `sub` (this file's own record key), not an
// alias — AWS's own reference for these four calls: "if username isn't an
// alias attribute in your user pool, this value must be the sub" — and a
// sub always works regardless of alias configuration, so nothing here
// depends on how `signInAliases` resolves for admin lookups.
const deactivateClinicianUser: AdminDeactivateClinicianPort = {
  async disable(subjectId) {
    await cognitoClient.send(
      new AdminDisableUserCommand({ UserPoolId: clinicianUserPoolId, Username: subjectId }),
    );
  },
  async revokeTokens(subjectId) {
    await cognitoClient.send(
      new AdminUserGlobalSignOutCommand({ UserPoolId: clinicianUserPoolId, Username: subjectId }),
    );
  },
  async getEmail(subjectId) {
    const response = await cognitoClient.send(
      new AdminGetUserCommand({ UserPoolId: clinicianUserPoolId, Username: subjectId }),
    );
    return response.UserAttributes?.find((attribute) => attribute.Name === 'email')?.Value;
  },
};

const reactivateClinicianUser: AdminReactivateClinicianPort = {
  async enable(subjectId) {
    await cognitoClient.send(
      new AdminEnableUserCommand({ UserPoolId: clinicianUserPoolId, Username: subjectId }),
    );
  },
};

// The Notifier this handler's one call (the deactivation notice,
// `clinicianDeactivated`) needs. It is never `smsEligible`
// (packages/i18n/src/notifications/index.ts), so the SMS path below is
// wired only to satisfy `NotifierDeps`'s type — `InMemorySmsFlagReader`'s
// default (`enabled: false`) means it could not send even if somehow
// reached. No origination identity is provisioned for this function, and
// none needs to be while nothing reachable through it is ever smsEligible.
const notifier = createNotifier({
  sendEmail: createSesGenericEmailSender({
    fromAddress: process.env.CLINICIAN_ADMIN_FROM_EMAIL ?? 'noreply@nourishthenerve.com',
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

export const handler = createClinicianAdminHandler({
  repository,
  flags,
  createClinicianUser,
  deactivateClinicianUser,
  reactivateClinicianUser,
  notifier,
});
