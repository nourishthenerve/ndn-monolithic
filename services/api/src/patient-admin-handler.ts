// D-29 (2026-08-29): the deployed Lambda entry for `POST /patients` and
// `POST /patients/{id}/reset-password` (infra/src/data-stack.ts) — same
// split every other endpoint uses: patient-admin.ts is SDK-free and
// unit-testable, this file wires the real Cognito Admin* calls and the
// real DynamoDB-backed repository.
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

import { AssessmentRepository } from './assessment-repository.js';
import { systemClock } from './clock.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { createPatientProfileStore, DynamoAssessmentStore } from './dynamo-store.js';
import type {
  AdminCreatePatientPort,
  AdminFindPatientPort,
  AdminSetPatientPasswordPort,
} from './patient-admin.js';
import { createPatientAdminHandler } from './patient-admin.js';
import { PatientRepository } from './patient-repository.js';
import { createSsmFlagReader } from './ssm-flag-source.js';

const flags = createSsmFlagReader();

const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';
const auditLog = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '' });

// `PAT#<sub>` / `PROFILE` — the key shape (and, since 2026-08-31, the
// GSI3 directory projection) that `createPatientProfileStore` owns for
// every handler, because the record id and the Cognito sub are the same
// value (dynamo-principal-directory.ts).
const repository = new PatientRepository(
  createPatientProfileStore(tableName),
  auditLog,
  systemClock,
);

const cognitoClient = new CognitoIdentityProviderClient({});
const patientUserPoolId = process.env.PATIENT_USER_POOL_ID ?? '';

/**
 * `MessageAction: 'SUPPRESS'` — the one setting that makes this design's
 * own trust boundary real. `AdminCreateUser`'s default behaviour emails or
 * texts a temporary password; this platform never has a verified address
 * to send one to and never wants Cognito to try. Staff relay the password
 * this function's own response carries, over WhatsApp, once.
 */
const createPatientUser: AdminCreatePatientPort = {
  async createUser(email) {
    try {
      const response = await cognitoClient.send(
        new AdminCreateUserCommand({
          UserPoolId: patientUserPoolId,
          Username: email,
          UserAttributes: [
            { Name: 'email', Value: email },
            // Staff typed this address in from a WhatsApp conversation —
            // no different a provenance than clinician-admin.ts's own
            // "the principal invited this address directly" reasoning for
            // the identical attribute.
            { Name: 'email_verified', Value: 'true' },
          ],
          MessageAction: 'SUPPRESS',
        }),
      );
      const sub = response.User?.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value;
      if (!sub) {
        throw new Error('AdminCreateUser did not return a sub attribute');
      }
      return { outcome: 'created', subjectId: sub };
    } catch (error) {
      if ((error as { name?: string }).name === 'UsernameExistsException') {
        return { outcome: 'exists' };
      }
      throw error;
    }
  },
};

/**
 * `Permanent: true` on every call — a temporary, force-change password
 * would leave a patient at a `NEW_PASSWORD_REQUIRED` challenge this pool's
 * client (auth-stack.ts, `ALLOW_USER_SRP_AUTH` only) has no self-service
 * step to resolve, and this design's whole point is that a patient never
 * sets their own password.
 */
const setPatientPassword: AdminSetPatientPasswordPort = {
  async setPassword(subjectId, password) {
    await cognitoClient.send(
      new AdminSetUserPasswordCommand({
        UserPoolId: patientUserPoolId,
        Username: subjectId,
        Password: password,
        Permanent: true,
      }),
    );
  },
};

/**
 * `AdminGetUser` by email — the pool's own username (TASK 2.2.1,
 * `UsernameAttributes: ['email']`), so this is a direct lookup, not a
 * scan or a second index. `UserNotFoundException` is the plain "no such
 * account" answer, not an error.
 */
const findPatientUser: AdminFindPatientPort = {
  async findByEmail(email) {
    try {
      const response = await cognitoClient.send(
        new AdminGetUserCommand({ UserPoolId: patientUserPoolId, Username: email }),
      );
      const sub = response.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value;
      if (!sub) {
        throw new Error('AdminGetUser did not return a sub attribute');
      }
      return { subjectId: sub };
    } catch (error) {
      if ((error as { name?: string }).name === 'UserNotFoundException') {
        return undefined;
      }
      throw error;
    }
  },
};

// 2026-09-01: the same `ASSESS#<id>#v<n>` rows the assessment function
// owns, reached from here for exactly one call — `instantiate`, at account
// creation. This function's IAM gains `PutItem`/`GetItem` on the patient
// partition it already writes the `PROFILE` row to, and nothing more: it
// cannot read a version back to a caller, because it has no route that
// returns one.
const assessments = new AssessmentRepository(
  new DynamoAssessmentStore({ tableName }),
  auditLog,
  systemClock,
);

export const handler = createPatientAdminHandler({
  repository,
  assessments,
  flags,
  audit: auditLog,
  createPatientUser,
  setPatientPassword,
  findPatientUser,
});
