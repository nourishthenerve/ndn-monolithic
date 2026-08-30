// TASK 2.4.1: the deployed Lambda entry for the clinician-admin routes
// (infra/src/data-stack.ts). Same split every other endpoint uses —
// clinician-admin.ts is SDK-free and unit-testable, this file is the only
// place that wires the real Cognito Admin* calls and the real
// DynamoDB-backed stores.
//
// D-32 (2026-08-30): the Notifier/SES wiring this file used to construct
// for the deactivation notice — and the `AdminGetUser` call that resolved
// an email for it — are deleted along with the notice itself.
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminInitiateAuthCommand,
  AdminRespondToAuthChallengeCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  AssociateSoftwareTokenCommand,
  CognitoIdentityProviderClient,
  VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { PRINCIPAL_CLINICIAN_GROUP } from './authorizer.js';
import {
  createClinicianAdminHandler,
  type AdminCreateClinicianPort,
  type AdminDeactivateClinicianPort,
  type AdminReactivateClinicianPort,
} from './clinician-admin.js';
import { ClinicianRepository } from './clinician-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoClinicianStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { buildOtpauthUri, generateTotpCode } from './totp.js';

const flags = createSsmFlagReader();

const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });
const repository = new ClinicianRepository(
  new DynamoClinicianStore({ tableName: process.env.CLINICIAN_TABLE_NAME ?? '' }),
  auditLog,
  systemClock,
);

const cognitoClient = new CognitoIdentityProviderClient({});
const clinicianUserPoolId = process.env.CLINICIAN_USER_POOL_ID ?? '';
// D-30: the server-side-only client `auth-stack.ts`'s `ClinicianAdminAuthClient`
// provisions — `ALLOW_ADMIN_USER_PASSWORD_AUTH` only, never the browser-facing
// `CLINICIAN_USER_POOL_CLIENT_ID` above it in this file's own env vars.
const clinicianAdminAuthClientId = process.env.CLINICIAN_ADMIN_AUTH_CLIENT_ID ?? '';
// The label an authenticator app shows next to the generated code — cosmetic
// only, not read back by Cognito or this codebase anywhere.
const TOTP_ISSUER = 'Nourish the Nerve';

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
        // D-30: no Cognito-sent invite of any kind — `setPassword`/
        // `provisionTotp` below are what give this account a working
        // credential, never an email Cognito delivers on its own.
        MessageAction: 'SUPPRESS',
      }),
    );
    const sub = response.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    if (!sub) {
      throw new Error('AdminCreateUser did not return a sub attribute');
    }
    return sub;
  },
  async addToPrincipalGroup(subjectId) {
    await cognitoClient.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: clinicianUserPoolId,
        Username: subjectId,
        GroupName: PRINCIPAL_CLINICIAN_GROUP,
      }),
    );
  },
  // D-30: `Permanent: true` — no `NEW_PASSWORD_REQUIRED` challenge for this
  // account to get stuck on, the identical shape `patient-admin.ts`'s own
  // `AdminSetUserPassword` call already uses for D-29.
  async setPassword(subjectId, password) {
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: clinicianUserPoolId,
        Username: subjectId,
        Password: password,
        Permanent: true,
      }),
    );
  },
  // D-30: completes Cognito's own `MFA_SETUP` challenge on the new
  // clinician's behalf — the one path that lets this codebase hand the
  // principal a working TOTP secret without a browser session, an email,
  // or the new clinician present. See totp.ts for the code computation
  // this relies on and clinician-admin.ts's own port header for the full
  // sequence.
  async provisionTotp(subjectId, email, password) {
    const initiate = await cognitoClient.send(
      new AdminInitiateAuthCommand({
        UserPoolId: clinicianUserPoolId,
        ClientId: clinicianAdminAuthClientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: subjectId, PASSWORD: password },
      }),
    );
    if (initiate.ChallengeName !== 'MFA_SETUP' || !initiate.Session) {
      // A brand-new user with MFA required and no device enrolled yet
      // should always land here — anything else means this account's
      // MFA state was not what this flow assumes, and proceeding would
      // silently skip enrolment rather than fail loudly.
      throw new Error(
        `Expected an MFA_SETUP challenge provisioning TOTP for a new clinician, got: ${
          initiate.ChallengeName ?? '(sign-in completed without a challenge)'
        }`,
      );
    }
    const associated = await cognitoClient.send(
      new AssociateSoftwareTokenCommand({ Session: initiate.Session }),
    );
    const secret = associated.SecretCode;
    if (!secret || !associated.Session) {
      throw new Error('AssociateSoftwareToken did not return a SecretCode and Session');
    }
    const verified = await cognitoClient.send(
      new VerifySoftwareTokenCommand({
        Session: associated.Session,
        // Computed by this codebase, never typed in by a human — the one
        // piece totp.ts exists for.
        UserCode: generateTotpCode(secret),
        FriendlyDeviceName: 'Provisioned by principal (D-30)',
      }),
    );
    if (verified.Status !== 'SUCCESS' || !verified.Session) {
      throw new Error(`VerifySoftwareToken did not succeed: ${verified.Status ?? '(no status)'}`);
    }
    await cognitoClient.send(
      new AdminRespondToAuthChallengeCommand({
        UserPoolId: clinicianUserPoolId,
        ClientId: clinicianAdminAuthClientId,
        ChallengeName: 'MFA_SETUP',
        Session: verified.Session,
        ChallengeResponses: { USERNAME: subjectId },
      }),
    );
    // Whatever session/tokens the challenge completion above minted are
    // discarded here, immediately — nothing from this admin-driven round
    // trip is meant to outlive the request that triggered it, the same
    // "no residual credential" discipline this file's `deactivate` path
    // already applies to a real session.
    await cognitoClient.send(
      new AdminUserGlobalSignOutCommand({ UserPoolId: clinicianUserPoolId, Username: subjectId }),
    );
    return {
      secret,
      otpauthUri: buildOtpauthUri({ secretBase32: secret, accountName: email, issuer: TOTP_ISSUER }),
    };
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
};

const reactivateClinicianUser: AdminReactivateClinicianPort = {
  async enable(subjectId) {
    await cognitoClient.send(
      new AdminEnableUserCommand({ UserPoolId: clinicianUserPoolId, Username: subjectId }),
    );
  },
};

export const handler = createClinicianAdminHandler({
  repository,
  flags,
  createClinicianUser,
  deactivateClinicianUser,
  reactivateClinicianUser,
});
