// TASK 2.2.2: the deployed Lambda entry for the API Gateway REQUEST
// authorizer on both HTTP APIs (infra/src/data-stack.ts wires it; the web
// API takes the same function as a cross-stack prop). Thin wiring only —
// the decision is authorizer.ts, the verification is jwt-verify.ts, the
// lookup is dynamo-principal-directory.ts, and all three are tested
// without AWS.
//
// **Every valid token denies today, and that is correct.** The directory
// lookup requires a `PAT#<sub>` or `CLI#<sub>` profile row, and TASK 2.2.3
// creates the first of those while TASK 2.4.1 creates the first of these.
// Until then a perfectly-signed token from either pool resolves to
// `no-directory-record` and is refused. A Cognito user with no record in
// this system is not a principal, and the authorizer is not the place to
// make an exception for the fact that the system is new.
import { createAuthorizer } from './authorizer.js';
import { DynamoPrincipalDirectory } from './dynamo-principal-directory.js';
import { createCognitoTokenVerifier, memoiseVerifier } from './jwt-verify.js';

// Built once per container, not per request: constructing the verifiers
// per invocation would discard aws-jwt-verify's JWKS cache and put an
// HTTPS round trip in front of every cold authorisation.
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

/**
 * The outermost catch, and the reason this file has any logic at all.
 *
 * API Gateway treats an *unhandled* authorizer exception as a `500` to the
 * caller, which is a refusal — but it is a refusal by accident, and it
 * depends on API Gateway's behaviour rather than on ours. This turns every
 * unexpected throw into an explicit `isAuthorized: false`, so "a 500 in
 * this function is a denial" is a property of the code and can be asserted
 * as one.
 */
export const handler = async (event: {
  headers?: Record<string, string | undefined>;
  routeKey?: string;
}): Promise<{ isAuthorized: boolean; context: Record<string, string> }> => {
  const authorize = createAuthorizer({ verifier: getVerifier(), directory });
  try {
    return await authorize(event);
  } catch {
    // Nothing from the error is logged: an exception message here could
    // carry a token fragment or a claim, and neither may reach CloudWatch
    // (R-09's "a log line"). The decision line is enough to see that a
    // request was refused and on which route.
    process.stdout.write(
      JSON.stringify({
        route: event.routeKey ?? 'unknown',
        allowed: false,
        reason: 'authorizer-error',
      }) + '\n',
    );
    return { isAuthorized: false, context: {} };
  }
};
