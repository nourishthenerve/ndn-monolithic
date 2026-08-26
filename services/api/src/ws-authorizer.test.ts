// TASK 4.1.1. The WebSocket-shaped twin of authorizer.test.ts — same
// verifier/directory doubles, same denial coverage, plus the one thing
// this authorizer alone decides: the `video.signalling.enabled` flag.
import { describe, expect, it } from 'vitest';

import {
  PRINCIPAL_CLINICIAN_GROUP,
  type AuthorizerDecisionLog,
  type DirectoryEntry,
  type PrincipalDirectory,
} from './authorizer.js';
import type { FlagReader } from './flags.js';
import type { TokenVerifier, VerifiedToken } from './jwt-verify.js';
import { createWebSocketAuthorizer, type WebSocketAuthorizerResult } from './ws-authorizer.js';

const PATIENT_SUB = 'b3c1f0e2-1111-4a3b-9c2d-000000000001';
const CLINICIAN_SUB = 'b3c1f0e2-2222-4a3b-9c2d-000000000002';
const METHOD_ARN = 'arn:aws:execute-api:eu-west-2:357601815388:abc123/prod/$connect';

function verifierReturning(token: VerifiedToken | undefined): TokenVerifier {
  return { verify: async () => token };
}

function directoryReturning(entry: DirectoryEntry | undefined): PrincipalDirectory {
  return { lookup: async () => entry };
}

function enabledFlags(): FlagReader {
  return { isEnabled: async () => true };
}

function disabledFlags(): FlagReader {
  return { isEnabled: async () => false };
}

function build(
  options: {
    verifier?: TokenVerifier;
    directory?: PrincipalDirectory;
    flags?: FlagReader;
  } = {},
) {
  const lines: AuthorizerDecisionLog[] = [];
  const authorize = createWebSocketAuthorizer({
    verifier: options.verifier ?? verifierReturning(undefined),
    directory: options.directory ?? directoryReturning(undefined),
    flags: options.flags ?? enabledFlags(),
    log: (decision) => lines.push(decision),
  });
  return { authorize, lines };
}

function event(token?: string) {
  return { methodArn: METHOD_ARN, queryStringParameters: token === undefined ? {} : { token } };
}

function approvedPatient() {
  return {
    verifier: verifierReturning({ pool: 'patient' as const, subjectId: PATIENT_SUB, groups: [] }),
    directory: directoryReturning({ recordId: PATIENT_SUB, accountStatus: 'approved' as const }),
  };
}

function allowStatement(result: WebSocketAuthorizerResult): WebSocketAuthorizerResult['policyDocument']['Statement'][number] {
  const [statement] = result.policyDocument.Statement;
  if (!statement) {
    throw new Error('expected exactly one policy statement');
  }
  return statement;
}

describe('a verified subject with a record is allowed', () => {
  it('returns an Allow policy on the connect methodArn, principalId the subjectId', async () => {
    const { authorize } = build(approvedPatient());
    const result = await authorize(event('good-token'));

    expect(allowStatement(result)).toEqual({
      Action: 'execute-api:Invoke',
      Effect: 'Allow',
      Resource: METHOD_ARN,
    });
    expect(result.principalId).toBe(PATIENT_SUB);
  });

  it('carries the same flat-string context the HTTP authorizer builds', async () => {
    const { authorize } = build(approvedPatient());
    const result = await authorize(event('good-token'));

    expect(result.context).toEqual({
      subjectId: PATIENT_SUB,
      role: 'patient',
      accountStatus: 'approved',
      patientId: PATIENT_SUB,
    });
  });

  it('promotes to principal-clinician only on the group claim', async () => {
    const { authorize } = build({
      verifier: verifierReturning({
        pool: 'clinician',
        subjectId: CLINICIAN_SUB,
        groups: [PRINCIPAL_CLINICIAN_GROUP],
      }),
      directory: directoryReturning({ recordId: CLINICIAN_SUB, accountStatus: 'active' }),
    });
    const result = await authorize(event('good-token'));

    expect(result.context.role).toBe('principal-clinician');
  });
});

describe('the flag gates the connect itself, since no downstream route can', () => {
  it('denies every connect attempt when the flag is off, before verifying the token', async () => {
    let verifyCalled = false;
    const { authorize, lines } = build({
      verifier: {
        verify: async () => {
          verifyCalled = true;
          return undefined;
        },
      },
      flags: disabledFlags(),
    });
    const result = await authorize(event('good-token'));

    expect(allowStatement(result).Effect).toBe('Deny');
    expect(verifyCalled).toBe(false);
    expect(lines[0]?.reason).toBe('flag-disabled');
  });

  it('allows once the flag is on, given an otherwise-valid token', async () => {
    const { authorize } = build({ ...approvedPatient(), flags: enabledFlags() });
    const result = await authorize(event('good-token'));

    expect(allowStatement(result).Effect).toBe('Allow');
  });
});

describe('every failure denies, with a Deny policy rather than a thrown error', () => {
  it('denies with no token in the querystring', async () => {
    const { authorize, lines } = build(approvedPatient());
    const result = await authorize(event(undefined));

    expect(allowStatement(result).Effect).toBe('Deny');
    expect(result.principalId).toBe('denied');
    expect(result.context).toEqual({});
    expect(lines[0]?.reason).toBe('no-bearer-token');
  });

  it('denies when the verifier rejects the token', async () => {
    const { authorize, lines } = build({
      verifier: verifierReturning(undefined),
      directory: directoryReturning({ recordId: PATIENT_SUB, accountStatus: 'approved' }),
    });
    const result = await authorize(event('expired'));

    expect(allowStatement(result).Effect).toBe('Deny');
    expect(lines[0]?.reason).toBe('token-not-verified');
  });

  it('denies a verified subject with no record in this system', async () => {
    const { authorize, lines } = build({
      verifier: verifierReturning({ pool: 'patient', subjectId: PATIENT_SUB, groups: [] }),
      directory: directoryReturning(undefined),
    });
    const result = await authorize(event('good-token'));

    expect(allowStatement(result).Effect).toBe('Deny');
    expect(lines[0]?.reason).toBe('no-directory-record');
  });

  it('denies when the directory lookup throws, rather than proceeding without a status', async () => {
    const { authorize, lines } = build({
      verifier: verifierReturning({ pool: 'patient', subjectId: PATIENT_SUB, groups: [] }),
      directory: {
        lookup: async () => {
          throw new Error('ProvisionedThroughputExceededException');
        },
      },
    });
    const result = await authorize(event('good-token'));

    expect(allowStatement(result).Effect).toBe('Deny');
    expect(lines[0]?.reason).toBe('lookup-failed');
  });
});

describe('the decision log', () => {
  it('logs $connect, allowed, subject, pool and role on an allow', async () => {
    const { authorize, lines } = build(approvedPatient());
    await authorize(event('good-token'));

    expect(lines).toEqual([
      { route: '$connect', allowed: true, subjectId: PATIENT_SUB, pool: 'patient', role: 'patient' },
    ]);
  });
});
