// TASK 2.2.2. This is the most security-sensitive unit in the repository,
// so the negatives outnumber the positives and each one is its own named
// test — a table-driven "rejects bad tokens" would report a single failure
// for nine different holes.
import { describe, expect, it } from 'vitest';

import {
  createAuthorizer,
  PRINCIPAL_CLINICIAN_GROUP,
  type AuthorizerDecisionLog,
  type DirectoryEntry,
  type PrincipalDirectory,
} from './authorizer.js';
import type { TokenPool, TokenVerifier, VerifiedToken } from './jwt-verify.js';

const PATIENT_SUB = 'b3c1f0e2-1111-4a3b-9c2d-000000000001';
const CLINICIAN_SUB = 'b3c1f0e2-2222-4a3b-9c2d-000000000002';

function verifierReturning(token: VerifiedToken | undefined): TokenVerifier {
  return { verify: async () => token };
}

function directoryReturning(entry: DirectoryEntry | undefined): PrincipalDirectory {
  return { lookup: async () => entry };
}

function build(options: {
  verifier?: TokenVerifier;
  directory?: PrincipalDirectory;
} = {}) {
  const lines: AuthorizerDecisionLog[] = [];
  const authorize = createAuthorizer({
    verifier: options.verifier ?? verifierReturning(undefined),
    directory: options.directory ?? directoryReturning(undefined),
    log: (decision) => lines.push(decision),
  });
  return { authorize, lines };
}

function event(header?: string, routeKey = 'GET /audit') {
  return { headers: header === undefined ? {} : { authorization: header }, routeKey };
}

function approvedPatient() {
  return {
    verifier: verifierReturning({ pool: 'patient', subjectId: PATIENT_SUB, groups: [] }),
    directory: directoryReturning({ recordId: PATIENT_SUB, accountStatus: 'approved' as const }),
  };
}

describe('the authorizer allows a verified subject with a record', () => {
  it('resolves a patient-pool token to a patient principal linked by patientId', async () => {
    const { authorize } = build(approvedPatient());
    const result = await authorize(event('Bearer good-token'));

    expect(result.isAuthorized).toBe(true);
    expect(result.context).toEqual({
      subjectId: PATIENT_SUB,
      role: 'patient',
      accountStatus: 'approved',
      patientId: PATIENT_SUB,
    });
    expect(result.context.clinicianId).toBeUndefined();
  });

  it('resolves a clinician-pool token to a sub-clinician when no group says otherwise', async () => {
    const { authorize } = build({
      verifier: verifierReturning({ pool: 'clinician', subjectId: CLINICIAN_SUB, groups: [] }),
      directory: directoryReturning({ recordId: CLINICIAN_SUB, accountStatus: 'active' }),
    });
    const result = await authorize(event('Bearer good-token'));

    expect(result.context.role).toBe('sub-clinician');
    expect(result.context.clinicianId).toBe(CLINICIAN_SUB);
    expect(result.context.patientId).toBeUndefined();
  });

  it('promotes to principal-clinician only on the group claim, which only an admin can set', async () => {
    const { authorize } = build({
      verifier: verifierReturning({
        pool: 'clinician',
        subjectId: CLINICIAN_SUB,
        groups: ['some-other-group', PRINCIPAL_CLINICIAN_GROUP],
      }),
      directory: directoryReturning({ recordId: CLINICIAN_SUB, accountStatus: 'active' }),
    });

    expect((await authorize(event('Bearer good-token'))).context.role).toBe('principal-clinician');
  });

  it('carries a non-operative status through rather than denying it — can() owns that call', async () => {
    // A suspended patient must still be able to read their own profile
    // (authz.ts's OPERATIVE_STATUSES gate). An authorizer that denied here
    // would put a second, divergent copy of that policy on the request path.
    const { authorize } = build({
      verifier: verifierReturning({ pool: 'patient', subjectId: PATIENT_SUB, groups: [] }),
      directory: directoryReturning({ recordId: PATIENT_SUB, accountStatus: 'suspended' }),
    });
    const result = await authorize(event('Bearer good-token'));

    expect(result.isAuthorized).toBe(true);
    expect(result.context.accountStatus).toBe('suspended');
  });
});

describe('the role comes from the issuer, never from a claim', () => {
  it('ignores a cognito:groups claim asserting principal-clinician on a patient-pool token', async () => {
    const { authorize } = build({
      verifier: verifierReturning({
        pool: 'patient',
        subjectId: PATIENT_SUB,
        groups: [PRINCIPAL_CLINICIAN_GROUP, 'sub-clinician'],
      }),
      directory: directoryReturning({ recordId: PATIENT_SUB, accountStatus: 'approved' }),
    });
    const result = await authorize(event('Bearer forged-groups'));

    expect(result.isAuthorized).toBe(true);
    expect(result.context.role).toBe('patient');
    expect(result.context.clinicianId).toBeUndefined();
  });

  it.each<TokenPool>(['patient', 'clinician'])(
    'links a %s-pool subject only to its own kind of identifier',
    async (pool) => {
      const { authorize } = build({
        verifier: verifierReturning({ pool, subjectId: 'subject-1', groups: [] }),
        directory: directoryReturning({ recordId: 'record-1', accountStatus: 'active' }),
      });
      const { context } = await authorize(event('Bearer good-token'));

      expect(context.patientId === undefined).toBe(pool !== 'patient');
      expect(context.clinicianId === undefined).toBe(pool !== 'clinician');
    },
  );
});

describe('every failure denies', () => {
  it('denies a request with no Authorization header', async () => {
    const { authorize, lines } = build(approvedPatient());
    const result = await authorize(event(undefined));

    expect(result).toEqual({ isAuthorized: false, context: {} });
    expect(lines[0]?.reason).toBe('no-bearer-token');
  });

  it('denies a Bearer with an empty token', async () => {
    const { authorize, lines } = build(approvedPatient());

    expect((await authorize(event('Bearer '))).isAuthorized).toBe(false);
    expect(lines[0]?.reason).toBe('no-bearer-token');
  });

  it('denies a header that is not a Bearer scheme', async () => {
    const { authorize } = build(approvedPatient());

    expect((await authorize(event('Basic aGk6dGhlcmU='))).isAuthorized).toBe(false);
  });

  it('denies when the verifier rejects the token', async () => {
    const { authorize, lines } = build({
      verifier: verifierReturning(undefined),
      directory: directoryReturning({ recordId: PATIENT_SUB, accountStatus: 'approved' }),
    });

    expect((await authorize(event('Bearer expired'))).isAuthorized).toBe(false);
    expect(lines[0]?.reason).toBe('token-not-verified');
  });

  it('denies a verified subject that has no record in this system', async () => {
    const { authorize, lines } = build({
      verifier: verifierReturning({ pool: 'patient', subjectId: PATIENT_SUB, groups: [] }),
      directory: directoryReturning(undefined),
    });

    expect((await authorize(event('Bearer good-token'))).isAuthorized).toBe(false);
    expect(lines[0]?.reason).toBe('no-directory-record');
  });

  // The test that proves "a 500 is a denial, not an allow". A directory
  // that throws is DynamoDB being unavailable, throttled, or misconfigured
  // — none of which is permission to proceed.
  it('denies when the directory lookup throws, rather than proceeding without a status', async () => {
    const { authorize, lines } = build({
      verifier: verifierReturning({ pool: 'patient', subjectId: PATIENT_SUB, groups: [] }),
      directory: {
        lookup: async () => {
          throw new Error('ProvisionedThroughputExceededException');
        },
      },
    });
    const result = await authorize(event('Bearer good-token'));

    expect(result).toEqual({ isAuthorized: false, context: {} });
    expect(lines[0]?.reason).toBe('lookup-failed');
  });

  it('returns an empty context on every denial, so nothing downstream can read a partial principal', async () => {
    const { authorize } = build({
      verifier: verifierReturning({ pool: 'clinician', subjectId: CLINICIAN_SUB, groups: [] }),
      directory: directoryReturning(undefined),
    });

    expect((await authorize(event('Bearer good-token'))).context).toEqual({});
  });
});

describe('the decision log carries identifiers and nothing else', () => {
  it('logs route, decision, subject, pool and role on an allow', async () => {
    const { authorize, lines } = build(approvedPatient());
    await authorize(event('Bearer good-token', 'GET /patients/me'));

    expect(lines).toEqual([
      {
        route: 'GET /patients/me',
        allowed: true,
        subjectId: PATIENT_SUB,
        pool: 'patient',
        role: 'patient',
      },
    ]);
  });

  it('never logs the subject of a token it could not verify', async () => {
    // An unverified token's `sub` is a string the caller chose. Logging it
    // would put attacker-controlled data in the trail dressed as identity.
    const { authorize, lines } = build({ verifier: verifierReturning(undefined) });
    await authorize(event('Bearer forged'));

    expect(lines[0]).toEqual({ route: 'GET /audit', allowed: false, reason: 'token-not-verified' });
    expect(lines[0]).not.toHaveProperty('subjectId');
  });

  it('never writes the token itself into any line', async () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.super-secret-payload.signature';
    const { authorize, lines } = build(approvedPatient());
    await authorize(event(`Bearer ${token}`));
    await authorize(event('Bearer other'));

    const serialised = JSON.stringify(lines);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain('super-secret-payload');
    expect(serialised).not.toContain('Bearer');
  });

  it('logs no email address, and cannot — nothing on the path carries one', async () => {
    const { authorize, lines } = build(approvedPatient());
    await authorize(event('Bearer good-token'));

    expect(JSON.stringify(lines)).not.toContain('@');
  });
});

describe('the header is read the way API Gateway sends it', () => {
  it('accepts the lowercase spelling the v2 payload uses', async () => {
    const { authorize } = build(approvedPatient());
    const result = await authorize({
      headers: { authorization: 'Bearer good-token' },
      routeKey: 'GET /audit',
    });

    expect(result.isAuthorized).toBe(true);
  });

  it('also accepts the capitalised spelling, so a v1-shaped event is not a silent denial', async () => {
    const { authorize } = build(approvedPatient());
    const result = await authorize({
      headers: { Authorization: 'Bearer good-token' },
      routeKey: 'GET /audit',
    });

    expect(result.isAuthorized).toBe(true);
  });
});
