import { describe, expect, it } from 'vitest';

import { normalizeUkE164 } from './sms-allow-list.js';

describe('normalizeUkE164', () => {
  it('normalises a UK national number (leading 0) to +44 E.164', () => {
    expect(normalizeUkE164('07911123456')).toBe('+447911123456');
  });

  it('normalises a UK number given without the leading +', () => {
    expect(normalizeUkE164('447911123456')).toBe('+447911123456');
  });

  it('passes through an already-E.164 UK mobile number unchanged', () => {
    expect(normalizeUkE164('+447911123456')).toBe('+447911123456');
  });

  it('strips spaces, hyphens and parentheses before validating', () => {
    expect(normalizeUkE164('+44 7911 123-456')).toBe('+447911123456');
    expect(normalizeUkE164('(07911) 123456')).toBe('+447911123456');
  });

  it('rejects non-UK numbers', () => {
    expect(normalizeUkE164('+12025550143')).toBeUndefined(); // US
    expect(normalizeUkE164('+33612345678')).toBeUndefined(); // FR
  });

  it('rejects a spoofed number that pastes the national 0 straight after +44', () => {
    expect(normalizeUkE164('+4401234567890')).toBeUndefined();
  });

  it('rejects a UK landline (not mobile range 7)', () => {
    expect(normalizeUkE164('+442012345678')).toBeUndefined();
  });

  it('rejects numbers that are the wrong length', () => {
    expect(normalizeUkE164('+44791112')).toBeUndefined(); // too short
    expect(normalizeUkE164('+4479111234567')).toBeUndefined(); // too long
  });

  it('rejects garbage input', () => {
    expect(normalizeUkE164('not a number')).toBeUndefined();
    expect(normalizeUkE164('')).toBeUndefined();
  });
});
