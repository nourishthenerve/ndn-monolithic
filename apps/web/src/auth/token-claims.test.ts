// The three-state contract is the whole point of this module, so it is
// what the suite is built around: `true`/`false` when the token says so,
// and `undefined` — never `false` — when the token cannot be read.
// Collapsing that third state into `false` is the specific mistake that
// would hide the admin pages from the principal, so each unreadable shape
// gets its own named case rather than one lumped "bad input" test.
import { describe, expect, it } from 'vitest';

import { isPrincipalClinician } from './token-claims.js';

/** A JWT-shaped string whose payload really is base64url JSON — signature never inspected, so any filler will do. */
function tokenWithPayload(payload: unknown): string {
  const json = JSON.stringify(payload);
  const base64url = Buffer.from(json, 'utf-8').toString('base64url');
  return `header.${base64url}.signature`;
}

describe('isPrincipalClinician', () => {
  it('is true when the groups claim carries principal-clinician', () => {
    expect(isPrincipalClinician(tokenWithPayload({ 'cognito:groups': ['principal-clinician'] }))).toBe(
      true,
    );
  });

  it('is true when principal-clinician sits alongside other groups', () => {
    expect(
      isPrincipalClinician(tokenWithPayload({ 'cognito:groups': ['something-else', 'principal-clinician'] })),
    ).toBe(true);
  });

  it('is false for a readable token whose groups claim does not carry it', () => {
    expect(isPrincipalClinician(tokenWithPayload({ 'cognito:groups': ['some-other-group'] }))).toBe(
      false,
    );
  });

  // Cognito omits the claim entirely rather than sending `[]`, so this is
  // the shape a real sub-clinician's token has — and it is a genuine "no",
  // not a failure to read.
  it('is false for a readable token with no groups claim at all — a sub-clinician', () => {
    expect(isPrincipalClinician(tokenWithPayload({ sub: 'abc', token_use: 'access' }))).toBe(false);
  });

  it.each([
    ['not a JWT at all', 'nonsense'],
    ['too few segments', 'header.payload'],
    ['too many segments', 'a.b.c.d'],
    ['a payload that is not base64url', 'header.!!!not-base64!!!.signature'],
    ['a payload that decodes to something other than JSON', `header.${Buffer.from('plain text').toString('base64url')}.signature`],
    ['a payload that is JSON but not an object', `header.${Buffer.from('"a string"').toString('base64url')}.signature`],
    ['an empty string', ''],
  ])('is undefined, never false, for %s', (_label, token) => {
    // The distinction the callers depend on: `undefined` means "show it
    // and let the server decide", `false` means "hide it".
    expect(isPrincipalClinician(token)).toBeUndefined();
  });

  it('decodes a payload needing base64 padding', () => {
    // Base64url drops `=` padding, and lengths that are not a multiple of
    // four are the common case, not the exception — a decoder that only
    // works on tidily-padded input fails on most real tokens.
    const token = tokenWithPayload({ 'cognito:groups': ['principal-clinician'], sub: 'x' });
    expect(token.split('.')[1]).not.toContain('=');
    expect(isPrincipalClinician(token)).toBe(true);
  });

  it('decodes a payload carrying multi-byte UTF-8', () => {
    expect(
      isPrincipalClinician(
        tokenWithPayload({ name: 'Zoë — Nourish the Nerve', 'cognito:groups': ['principal-clinician'] }),
      ),
    ).toBe(true);
  });
});
