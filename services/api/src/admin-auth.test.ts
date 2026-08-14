import { describe, expect, it } from 'vitest';

import { extractBearerToken, verifyAdminToken } from './admin-auth.js';

const EXPECTED = 'correct-horse-battery-staple';

describe('extractBearerToken', () => {
  it('returns the token from a well-formed header', () => {
    expect(extractBearerToken(`Bearer ${EXPECTED}`)).toBe(EXPECTED);
  });

  it('returns undefined for a missing header', () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
  });

  it('returns undefined for a header missing the Bearer prefix', () => {
    expect(extractBearerToken(EXPECTED)).toBeUndefined();
  });

  it('returns undefined for "Bearer " with nothing after it', () => {
    expect(extractBearerToken('Bearer ')).toBeUndefined();
  });
});

describe('verifyAdminToken', () => {
  it('accepts the correct token', () => {
    expect(verifyAdminToken(`Bearer ${EXPECTED}`, EXPECTED)).toBe(true);
  });

  it('rejects a wrong token of the same length', () => {
    expect(verifyAdminToken('Bearer correct-horse-battery-staplf', EXPECTED)).toBe(false);
  });

  it('rejects a wrong token of a different length', () => {
    expect(verifyAdminToken('Bearer short', EXPECTED)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifyAdminToken(undefined, EXPECTED)).toBe(false);
  });

  it('rejects a malformed header with no Bearer prefix', () => {
    expect(verifyAdminToken(EXPECTED, EXPECTED)).toBe(false);
  });
});
