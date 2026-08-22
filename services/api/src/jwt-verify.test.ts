// TASK 2.2.2. The signature-level attacks (`alg: none`, an RS256 token
// re-signed as HS256 with the public key as the secret, a token signed by
// the wrong key) are aws-jwt-verify's job and it has its own suite for
// them — reimplementing that here would test AWS's library, not ours.
//
// What *is* ours, and what these tests pin, is the wiring around it: that
// each of those attacks reaches the verifier at all rather than being
// short-circuited, that a rejection from one pool is not an acceptance by
// the other, and that nothing about which failure occurred escapes.
import { describe, expect, it, vi } from 'vitest';

import { extractBearerToken, verifierOver } from './jwt-verify.js';

const PATIENT_SUB = 'sub-patient-1';
const CLINICIAN_SUB = 'sub-clinician-1';

function rejecting(error: string) {
  return async () => {
    throw new Error(error);
  };
}

function poolVerifiers(options: {
  patient?: (token: string) => Promise<{ sub: string; 'cognito:groups'?: string[] }>;
  clinician?: (token: string) => Promise<{ sub: string; 'cognito:groups'?: string[] }>;
} = {}) {
  return [
    { pool: 'patient' as const, verify: options.patient ?? rejecting('JwtInvalidIssuerError') },
    { pool: 'clinician' as const, verify: options.clinician ?? rejecting('JwtInvalidIssuerError') },
  ];
}

describe('extractBearerToken', () => {
  it('returns the token from a well-formed header', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['bearer with nothing after it', 'Bearer '],
    ['lowercase scheme', 'bearer abc.def.ghi'],
    ['a different scheme', 'Basic abc'],
    ['the raw token with no scheme', 'abc.def.ghi'],
  ])('returns undefined for a %s header', (_name, header) => {
    expect(extractBearerToken(header)).toBeUndefined();
  });
});

describe('the pool is whichever key set verified the signature', () => {
  it('reports the patient pool when the patient verifier accepts', async () => {
    const verifier = verifierOver(poolVerifiers({ patient: async () => ({ sub: PATIENT_SUB }) }));

    expect(await verifier.verify('token')).toEqual({
      pool: 'patient',
      subjectId: PATIENT_SUB,
      groups: [],
    });
  });

  it('falls through to the clinician verifier when the patient one rejects', async () => {
    const verifier = verifierOver(
      poolVerifiers({
        clinician: async () => ({ sub: CLINICIAN_SUB, 'cognito:groups': ['principal-clinician'] }),
      }),
    );

    expect(await verifier.verify('token')).toEqual({
      pool: 'clinician',
      subjectId: CLINICIAN_SUB,
      groups: ['principal-clinician'],
    });
  });

  it('stops at the first verifier that accepts, so a token is attributed to one pool only', async () => {
    const clinician = vi.fn(async () => ({ sub: CLINICIAN_SUB }));
    const verifier = verifierOver(
      poolVerifiers({ patient: async () => ({ sub: PATIENT_SUB }), clinician }),
    );

    expect((await verifier.verify('token'))?.pool).toBe('patient');
    expect(clinician).not.toHaveBeenCalled();
  });
});

describe('every verification failure looks the same', () => {
  it.each([
    ['an expired token', 'JwtExpiredError'],
    ['a token signed with the wrong key', 'JwtInvalidSignatureError'],
    ['alg: none', 'JwtParseError: alg none'],
    ['an RS256 token re-signed as HS256', 'JwtInvalidSignatureAlgorithmError'],
    ['the other pool as issuer', 'JwtInvalidIssuerError'],
    ['a wrong aud / client_id', 'JwtInvalidClaimError: client_id'],
    ['a wrong token_use', 'JwtInvalidClaimError: token_use'],
    ['an unreachable JWKS endpoint', 'FetchError: getaddrinfo ENOTFOUND'],
  ])('resolves undefined for %s, and does not throw', async (_name, error) => {
    const verifier = verifierOver(poolVerifiers({ patient: rejecting(error), clinician: rejecting(error) }));

    await expect(verifier.verify('token')).resolves.toBeUndefined();
  });

  it('denies rather than inventing an identity when a verified token carries no sub', async () => {
    const verifier = verifierOver(
      poolVerifiers({ patient: async () => ({ sub: '' } as { sub: string }) }),
    );

    expect(await verifier.verify('token')).toBeUndefined();
  });

  it('does not fall through to the other pool once one has accepted a subject-less token', async () => {
    // A verified-but-unusable token is a denial, not a reason to keep
    // looking for a pool that will have it.
    const clinician = vi.fn(async () => ({ sub: CLINICIAN_SUB }));
    const verifier = verifierOver(
      poolVerifiers({ patient: async () => ({ sub: '' } as { sub: string }), clinician }),
    );

    expect(await verifier.verify('token')).toBeUndefined();
    expect(clinician).not.toHaveBeenCalled();
  });
});

describe('the groups claim is read defensively', () => {
  it('is an empty list when the claim is absent', async () => {
    const verifier = verifierOver(poolVerifiers({ clinician: async () => ({ sub: CLINICIAN_SUB }) }));

    expect((await verifier.verify('token'))?.groups).toEqual([]);
  });

  it('drops non-string members rather than passing them to the role decision', async () => {
    const verifier = verifierOver(
      poolVerifiers({
        clinician: async () =>
          ({ sub: CLINICIAN_SUB, 'cognito:groups': ['ok', 7, null] } as unknown as {
            sub: string;
            'cognito:groups'?: string[];
          }),
      }),
    );

    expect((await verifier.verify('token'))?.groups).toEqual(['ok']);
  });

  it('is an empty list when the claim is not an array at all', async () => {
    const verifier = verifierOver(
      poolVerifiers({
        clinician: async () =>
          ({ sub: CLINICIAN_SUB, 'cognito:groups': 'principal-clinician' } as unknown as {
            sub: string;
            'cognito:groups'?: string[];
          }),
      }),
    );

    expect((await verifier.verify('token'))?.groups).toEqual([]);
  });
});
