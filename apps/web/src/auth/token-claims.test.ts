// The three-state contract is the whole point of this module, so it is
// what the suite is built around: `true`/`false` when the token says so,
// and `undefined` — never `false` — when the token cannot be read.
// Collapsing that third state into `false` is the specific mistake that
// would hide the admin pages from the principal, so each unreadable shape
// gets its own named case rather than one lumped "bad input" test.
import { describe, expect, it } from 'vitest';

import { clinicianUserPoolIssuer, patientUserPoolIssuer } from '../site-config.js';

import { viewerRoleFromAccessToken } from './token-claims.js';

/** A JWT-shaped string whose payload really is base64url JSON — signature never inspected, so any filler will do. */
function tokenWithPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const base64url = Buffer.from(json, 'utf-8').toString('base64url');
  return `header.${base64url}.signature`;
}

/** A clinician-pool token — the pool decides first, so every group case has to carry the right `iss`. */
function clinicianToken(payload: Record<string, unknown> = {}): string {
  return tokenWithPayload({ iss: clinicianUserPoolIssuer, ...payload });
}

describe('viewerRoleFromAccessToken', () => {
  it('reads principal-clinician off the groups claim', () => {
    expect(
      viewerRoleFromAccessToken(clinicianToken({ 'cognito:groups': ['principal-clinician'] })),
    ).toBe('principal-clinician');
  });

  it('reads it when it sits alongside other groups', () => {
    expect(
      viewerRoleFromAccessToken(
        clinicianToken({ 'cognito:groups': ['something-else', 'principal-clinician'] }),
      ),
    ).toBe('principal-clinician');
  });

  it('reads helpdesk off the groups claim', () => {
    expect(viewerRoleFromAccessToken(clinicianToken({ 'cognito:groups': ['helpdesk'] }))).toBe(
      'helpdesk',
    );
  });

  // Mirrors `authorizer.ts`'s own precedence exactly. A UI that resolved
  // this the other way would hide pages the API would have allowed.
  it('prefers principal-clinician over helpdesk when a token carries both', () => {
    expect(
      viewerRoleFromAccessToken(
        clinicianToken({ 'cognito:groups': ['helpdesk', 'principal-clinician'] }),
      ),
    ).toBe('principal-clinician');
  });

  it('is sub-clinician for a clinician-pool token in neither named group', () => {
    expect(
      viewerRoleFromAccessToken(clinicianToken({ 'cognito:groups': ['some-other-group'] })),
    ).toBe('sub-clinician');
  });

  // The pool decides first and absolutely — `authorizer.ts`'s own rule,
  // and the reason two pools exist. A patient-pool token claiming a staff
  // group is still a patient here, exactly as it is on the server.
  it('is patient for a patient-pool token, whatever its groups claim says', () => {
    expect(
      viewerRoleFromAccessToken(
        tokenWithPayload({
          iss: patientUserPoolIssuer,
          'cognito:groups': ['principal-clinician', 'helpdesk'],
        }),
      ),
    ).toBe('patient');
  });

  it('is undefined for a token from neither known pool — not a guess', () => {
    expect(
      viewerRoleFromAccessToken(
        tokenWithPayload({ iss: 'https://cognito-idp.eu-west-2.amazonaws.com/eu-west-2_someoneelse' }),
      ),
    ).toBeUndefined();
  });

  // Cognito omits the claim entirely rather than sending `[]`, so this is
  // the shape a real sub-clinician's token has — and it is a genuine "no",
  // not a failure to read.
  it('is sub-clinician for a clinician-pool token with no groups claim at all', () => {
    expect(viewerRoleFromAccessToken(clinicianToken({ sub: 'abc', token_use: 'access' }))).toBe(
      'sub-clinician',
    );
  });

  it.each([
    ['not a JWT at all', 'nonsense'],
    ['too few segments', 'header.payload'],
    ['too many segments', 'a.b.c.d'],
    ['a payload that is not base64url', 'header.!!!not-base64!!!.signature'],
    ['a payload that decodes to something other than JSON', `header.${Buffer.from('plain text').toString('base64url')}.signature`],
    ['a payload that is JSON but not an object', `header.${Buffer.from('"a string"').toString('base64url')}.signature`],
    ['an empty string', ''],
  ])('is undefined, never a role, for %s', (_label, token) => {
    // The distinction the callers depend on: `undefined` means "show it
    // and let the server decide"; any role, `'other'` included, is a
    // positive answer a caller may hide on.
    expect(viewerRoleFromAccessToken(token)).toBeUndefined();
  });

  it('decodes a payload needing base64 padding', () => {
    // Base64url drops `=` padding, and lengths that are not a multiple of
    // four are the common case, not the exception — a decoder that only
    // works on tidily-padded input fails on most real tokens.
    const token = clinicianToken({ 'cognito:groups': ['principal-clinician'], sub: 'x' });
    expect(token.split('.')[1]).not.toContain('=');
    expect(viewerRoleFromAccessToken(token)).toBe('principal-clinician');
  });

  it('decodes a payload carrying multi-byte UTF-8', () => {
    expect(
      viewerRoleFromAccessToken(
        clinicianToken({ name: 'Zoë — Nourish the Nerve', 'cognito:groups': ['principal-clinician'] }),
      ),
    ).toBe('principal-clinician');
  });
});
