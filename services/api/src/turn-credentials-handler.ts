// TASK 4.4.1: the deployed Lambda entry for
// POST /calls/{appointmentId}/turn-credentials (infra/src/data-stack.ts)
// — same split every other endpoint in this codebase uses:
// turn-credentials.ts is SDK-free and unit-testable, this file wires the
// real DynamoDB-backed repositories, the real SSM-sourced API token, and
// the real `fetch` together.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { AppointmentRepository } from './appointment-repository.js';
import { systemClock } from './clock.js';
import { DynamoConnectionRepository } from './connection-repository.js';
import { DynamoAuditLog } from './dynamo-audit-log.js';
import { DynamoAppointmentStore } from './dynamo-store.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createTurnCredentialsHandler } from './turn-credentials.js';

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const tableName = process.env.PRINCIPAL_TABLE_NAME ?? '';

const audit = new DynamoAuditLog({ tableName: process.env.AUDIT_TABLE_NAME ?? '', client: dynamoClient });
const appointments = new AppointmentRepository(
  new DynamoAppointmentStore({ tableName, client: dynamoClient }),
  audit,
  systemClock,
);
const connections = new DynamoConnectionRepository({ tableName, clock: systemClock, client: dynamoClient });
const flags = createSsmFlagReader();

// Mirrors infra/src/config.ts's CLOUDFLARE_TURN_KEY_ID/
// CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME — those constants are what
// data-stack.ts actually sets these env vars to at deploy time; the
// literals here are only a local-dev/test fallback, same convention
// contact-form-handler.ts documents for TURNSTILE_SECRET_PARAMETER_NAME.
const CLOUDFLARE_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_KEY_ID ?? '';
const CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME =
  process.env.CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME ?? '/ndn/cloudflare-turn-api-token';

const ssmClient = new SSMClient({});

// Resolved once per cold start and reused for the execution environment's
// lifetime — same rationale as contact-form-handler.ts's own
// cachedSecretPromise (a failed read is never cached, so a transient SSM
// blip doesn't wedge a warm container).
let cachedTokenPromise: Promise<string> | undefined;

function getApiToken(): Promise<string> {
  cachedTokenPromise ??= ssmClient
    .send(
      new GetParameterCommand({ Name: CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME, WithDecryption: true }),
    )
    .then((result) => {
      const value = result.Parameter?.Value;
      if (!value) {
        throw new Error(`SSM parameter ${CLOUDFLARE_TURN_API_TOKEN_PARAMETER_NAME} has no value`);
      }
      return value;
    })
    .catch((error: unknown) => {
      cachedTokenPromise = undefined;
      throw error;
    });
  return cachedTokenPromise;
}

export const handler = createTurnCredentialsHandler({
  appointments,
  connections,
  flags,
  keyId: CLOUDFLARE_TURN_KEY_ID,
  getApiToken,
});
