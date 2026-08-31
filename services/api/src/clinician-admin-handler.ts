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
  ChangePasswordCommand,
  CognitoIdentityProviderClient,
  VerifySoftwareTokenCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { PRINCIPAL_CLINICIAN_GROUP } from './authorizer.js';
import {
  createClinicianAdminHandler,
  type AdminCreateClinicianPort,
  type AdminDeactivateClinicianPort,
  type AdminReactivateClinicianPort,
  type ChangeOwnPasswordPort,
} from './clinician-admin.js';
import { ClinicianRepository } from './clinician-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoClinicianStore } from './dynamo-store.js';
import { AppError } from './errors.js';
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
    let response;
    try {
      response = await cognitoClient.send(
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
    } catch (error) {
      // 2026-08-31: mapped rather than left to surface as a 500 — see
      // clinician-admin.ts's own note where this becomes a 409. The
      // identical translation `patient-admin-handler.ts` has done since
      // D-29.
      if ((error as { name?: string }).name === 'UsernameExistsException') {
        throw new AppError(
          'COGNITO_ACCOUNT_ALREADY_EXISTS',
          'a Cognito account with this email already exists',
        );
      }
      throw error;
    }
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
  //
  // 2026-08-31: `InvalidPasswordException` is translated here because the
  // password may now be one the principal typed (clinician-admin.ts's own
  // amendment) rather than one `password-generator.ts` produced —
  // Cognito's policy is the judge, and its verdict has to reach the form
  // as a 400 rather than a 500.
  async setPassword(subjectId, password) {
    try {
      await cognitoClient.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: clinicianUserPoolId,
          Username: subjectId,
          Password: password,
          Permanent: true,
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === 'InvalidPasswordException') {
        throw new AppError(
          'PASSWORD_POLICY_VIOLATION',
          'AdminSetUserPassword: password rejected by the pool policy',
        );
      }
      throw error;
    }
  },
  // D-30: completes Cognito's own `MFA_SETUP` challenge on the new
  // clinician's behalf — the one path that lets this codebase hand the
  // principal a working TOTP secret without a browser session, an email,
  // or the new clinician present. See totp.ts for the code computation
  // this relies on and clinician-admin.ts's own port header for the full
  // sequence.
  //
  // Amendment, 2026-08-31: the pool's `mfa` moved from `REQUIRED` to
  // `OPTIONAL` (auth-stack.ts's own header on that change has the full
  // reasoning). A brand-new user under `REQUIRED` always landed on
  // `MFA_SETUP` here; under `OPTIONAL` with no device yet enrolled,
  // `AdminInitiateAuth` now completes outright instead — no challenge,
  // real tokens back immediately. That is expected now, not a fault:
  // this port returns `undefined` rather than throwing, and the caller
  // (clinician-admin.ts) treats "no TOTP was provisioned" as a normal
  // outcome, the same way a clinician who signs in with password alone
  // is a normal outcome under `OPTIONAL`.
  async provisionTotp(subjectId, email, password) {
    const initiate = await cognitoClient.send(
      new AdminInitiateAuthCommand({
        UserPoolId: clinicianUserPoolId,
        ClientId: clinicianAdminAuthClientId,
        AuthFlow: 'ADMIN_USER_PASSWORD_AUTH',
        AuthParameters: { USERNAME: subjectId, PASSWORD: password },
      }),
    );
    if (!initiate.ChallengeName) {
      // Sign-in completed outright — MFA is optional and nothing is
      // enrolled yet. Nothing to provision; still sign out the session
      // this round trip minted, the same "no residual credential"
      // discipline the rest of this function follows.
      await cognitoClient.send(
        new AdminUserGlobalSignOutCommand({ UserPoolId: clinicianUserPoolId, Username: subjectId }),
      );
      return undefined;
    }
    if (initiate.ChallengeName !== 'MFA_SETUP' || !initiate.Session) {
      // Some other challenge — not the no-challenge case above, and not
      // the `MFA_SETUP` case this flow knows how to complete. This
      // account's state was not what either path assumes, and
      // proceeding would silently skip enrolment rather than fail
      // loudly.
      throw new Error(
        `Expected either no challenge or an MFA_SETUP challenge provisioning TOTP for a new clinician, got: ${initiate.ChallengeName}`,
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

// D-34 (2026-08-31): `ChangePassword`, not an Admin* call — the caller's
// own access token is the proof of identity, the same reason
// clinician-admin.ts's own header on `ChangeOwnPasswordPort` gives for
// reading it off the request rather than routing through `can()`.
const changeOwnPassword: ChangeOwnPasswordPort = {
  async changePassword(accessToken, currentPassword, newPassword) {
    try {
      await cognitoClient.send(
        new ChangePasswordCommand({
          AccessToken: accessToken,
          PreviousPassword: currentPassword,
          ProposedPassword: newPassword,
        }),
      );
    } catch (error) {
      // `NotAuthorizedException` covers both a wrong current password and
      // an expired/invalid access token — Cognito does not distinguish,
      // and neither does this codebase: either way, the caller has not
      // proven they hold the credential they are trying to change.
      if ((error as { name?: string }).name === 'NotAuthorizedException') {
        throw new AppError('INCORRECT_CURRENT_PASSWORD', 'ChangePassword: not authorized');
      }
      if ((error as { name?: string }).name === 'InvalidPasswordException') {
        throw new AppError('PASSWORD_POLICY_VIOLATION', 'ChangePassword: new password rejected');
      }
      throw error;
    }
  },
};

export const handler = createClinicianAdminHandler({
  repository,
  flags,
  createClinicianUser,
  deactivateClinicianUser,
  reactivateClinicianUser,
  changeOwnPassword,
});
