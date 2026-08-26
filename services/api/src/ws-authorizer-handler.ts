// TASK 4.1.1 step 2: the deployed Lambda entry for the $connect route's
// REQUEST authorizer (infra/src/data-stack.ts wires it via
// infra/src/ws-authorizer.ts's `WebSocketLambdaAuthorizer`). Thin wiring
// only, the same split authorizer-handler.ts already establishes for the
// HTTP authorizer — the decision is ws-authorizer.ts, the verification is
// jwt-verify.ts, the lookup is dynamo-principal-directory.ts, and all
// three are tested without AWS.
import { DynamoPrincipalDirectory } from './dynamo-principal-directory.js';
import { createCognitoTokenVerifier, memoiseVerifier } from './jwt-verify.js';
import { createSsmFlagReader } from './ssm-flag-source.js';
import { createWebSocketAuthorizer, denyPolicy, type WebSocketAuthorizerResult } from './ws-authorizer.js';

// Built once per container, not per request — see authorizer-handler.ts's
// identical comment on why.
const getVerifier = memoiseVerifier(() =>
  createCognitoTokenVerifier({
    patientUserPoolId: process.env.PATIENT_USER_POOL_ID ?? '',
    patientClientId: process.env.PATIENT_USER_POOL_CLIENT_ID ?? '',
    clinicianUserPoolId: process.env.CLINICIAN_USER_POOL_ID ?? '',
    clinicianClientId: process.env.CLINICIAN_USER_POOL_CLIENT_ID ?? '',
  }),
);

const directory = new DynamoPrincipalDirectory({
  tableName: process.env.PRINCIPAL_TABLE_NAME ?? '',
});

const flags = createSsmFlagReader();

/**
 * The outermost catch, and the reason this file has any logic at all —
 * authorizer-handler.ts's identical reasoning applies: an *unhandled*
 * exception here must become an explicit Deny policy, not depend on
 * whatever API Gateway does with a raw Lambda failure.
 */
export const handler = async (event: {
  methodArn: string;
  queryStringParameters?: Record<string, string | undefined> | null;
}): Promise<WebSocketAuthorizerResult> => {
  const authorize = createWebSocketAuthorizer({ verifier: getVerifier(), directory, flags });
  try {
    return await authorize(event);
  } catch {
    // Nothing from the error is logged — same reasoning authorizer-handler.ts
    // states: an exception message here could carry a token fragment.
    process.stdout.write(
      JSON.stringify({ route: '$connect', allowed: false, reason: 'authorizer-error' }) + '\n',
    );
    return denyPolicy(event.methodArn);
  }
};
