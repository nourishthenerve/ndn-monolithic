import { describe, expect, it } from 'vitest';

import { base32Decode, buildOtpauthUri, computeHotp, generateTotpCode } from './totp.js';

describe('base32Decode', () => {
  // RFC 4648 §10's own test vectors, verbatim — not self-consistency, a
  // named external source, the same bar `generateTotpCode`'s own tests
  // hold themselves to below.
  it.each([
    ['', ''],
    ['MY======', 'f'],
    ['MZXQ====', 'fo'],
    ['MZXW6===', 'foo'],
    ['MZXW6YQ=', 'foob'],
    ['MZXW6YTB', 'fooba'],
    ['MZXW6YTBOI======', 'foobar'],
  ])('decodes %s to %s (RFC 4648 §10)', (encoded, decoded) => {
    expect(base32Decode(encoded).toString('ascii')).toBe(decoded);
  });

  it('tolerates lower case and missing padding — the shape Cognito actually returns', () => {
    expect(base32Decode('mzxw6ytboi').toString('ascii')).toBe('foobar');
  });

  it('rejects a character outside the alphabet rather than silently dropping it', () => {
    expect(() => base32Decode('MZX!6YTB')).toThrow(/Invalid base32 character/);
  });
});

describe('computeHotp — RFC 6238 Appendix B\'s own test vectors', () => {
  // The RFC's SHA1 test secret is this exact 20-byte ASCII string — stated
  // against a raw key and an explicit counter, not a Base32 secret or
  // wall-clock time, which is exactly why this seam exists separately from
  // generateTotpCode below.
  const RFC_TEST_KEY = Buffer.from('12345678901234567890', 'ascii');

  it.each([
    [1n, '94287082'], // T = 59
    [37037036n, '07081804'], // T = 1111111109
    [37037037n, '14050471'], // T = 1111111111
    [41152263n, '89005924'], // T = 1234567890
    [66666666n, '69279037'], // T = 2000000000
    [666666666n, '65353130'], // T = 20000000000
  ])('counter %s produces the RFC\'s own 8-digit code %s', (counter, expected) => {
    expect(computeHotp(RFC_TEST_KEY, counter, 8)).toBe(expected);
  });
});

describe('generateTotpCode', () => {
  const secret = 'JBSWY3DPEHPK3PXP'; // an arbitrary, valid Base32 string — no RFC vector at this layer, only computeHotp's own test above needs one

  it('is deterministic within the same 30-second step', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const first = generateTotpCode(secret, { at });
    const second = generateTotpCode(secret, { at: new Date(at.getTime() + 5_000) });
    expect(first).toBe(second);
  });

  it('changes once the step boundary is crossed', () => {
    const at = new Date('2026-01-01T00:00:00.000Z');
    const before = generateTotpCode(secret, { at });
    const after = generateTotpCode(secret, { at: new Date(at.getTime() + 30_000) });
    expect(before).not.toBe(after);
  });

  it('defaults to 6 digits, zero-padded', () => {
    for (let i = 0; i < 20; i++) {
      const code = generateTotpCode(secret, { at: new Date(2026, 0, 1, 0, 0, i * 31) });
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('honours an explicit digit count', () => {
    expect(generateTotpCode(secret, { at: new Date(), digits: 8 })).toMatch(/^\d{8}$/);
  });
});

describe('buildOtpauthUri', () => {
  it('produces a URI an authenticator app can scan or accept for manual entry', () => {
    const uri = buildOtpauthUri({
      secretBase32: 'JBSWY3DPEHPK3PXP',
      accountName: 'colleague@example.com',
      issuer: 'Nourish the Nerve',
    });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    const parsed = new URL(uri);
    expect(parsed.searchParams.get('secret')).toBe('JBSWY3DPEHPK3PXP');
    expect(parsed.searchParams.get('issuer')).toBe('Nourish the Nerve');
    expect(parsed.searchParams.get('algorithm')).toBe('SHA1');
    expect(parsed.searchParams.get('digits')).toBe('6');
    expect(parsed.searchParams.get('period')).toBe('30');
    // `otpauth://totp/<label>` parses with `totp` as the URL's host and
    // the label as its path — not part of the path itself.
    expect(parsed.hostname).toBe('totp');
    // The label carries both issuer and account name, matching every
    // authenticator app's own display convention.
    expect(decodeURIComponent(parsed.pathname.replace(/^\//, ''))).toBe(
      'Nourish the Nerve:colleague@example.com',
    );
  });
});
