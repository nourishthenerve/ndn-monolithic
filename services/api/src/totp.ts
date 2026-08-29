// D-30: provisioning a clinician's TOTP secret admin-side (no email, no
// browser session for the new clinician to enrol through) needs this
// codebase to compute a valid 6-digit code from a Base32 secret itself, so
// it can complete Cognito's own `VerifySoftwareToken` challenge on the
// principal's behalf. RFC 6238 (TOTP) built on RFC 4226 (HOTP), both
// implemented directly against `node:crypto`'s HMAC — no dependency added,
// the same "no dependency without a concrete need" discipline
// `password-generator.ts` already established for D-29's password
// generation. Verified against RFC 6238's own Appendix B test vectors
// (totp.test.ts), not just self-consistency.
import { createHmac } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 Base32 — the alphabet Cognito's own `AssociateSoftwareToken` returns `SecretCode` in. Padding (`=`) and case are both tolerated; anything else in the alphabet is not. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = '';
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) {
      throw new Error(`Invalid base32 character: ${char}`);
    }
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

/**
 * RFC 4226 HOTP — the counter-based core both HOTP and TOTP share. Exported
 * so totp.test.ts can verify it directly against RFC 6238's own Appendix B
 * vectors, which are stated against a raw key and an explicit counter, not
 * a Base32 secret or wall-clock time.
 */
export function computeHotp(key: Buffer, counter: bigint, digits: number): string {
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(counter);
  const hmac = createHmac('sha1', key).update(counterBuffer).digest();
  const offset = (hmac[hmac.length - 1] as number) & 0x0f;
  const binary =
    (((hmac[offset] as number) & 0x7f) << 24) |
    (((hmac[offset + 1] as number) & 0xff) << 16) |
    (((hmac[offset + 2] as number) & 0xff) << 8) |
    ((hmac[offset + 3] as number) & 0xff);
  const otp = binary % 10 ** digits;
  return otp.toString().padStart(digits, '0');
}

export interface TotpOptions {
  /** Defaults to now — injectable so a test can pin a specific instant rather than racing a real 30-second window. */
  readonly at?: Date;
  readonly stepSeconds?: number;
  readonly digits?: number;
}

/**
 * RFC 6238 TOTP: the same HOTP core, with the counter derived from wall-clock
 * time instead of an explicit value. This is the function that computes the
 * one code `clinician-admin-handler.ts`'s own `VerifySoftwareToken` call
 * needs — the admin side of D-30's enrolment, immediately after Cognito's
 * `AssociateSoftwareToken` hands back a fresh secret, never a stored or
 * reused one.
 */
export function generateTotpCode(secretBase32: string, options: TotpOptions = {}): string {
  const stepSeconds = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const at = options.at ?? new Date();
  const counter = BigInt(Math.floor(at.getTime() / 1000 / stepSeconds));
  return computeHotp(base32Decode(secretBase32), counter, digits);
}

/**
 * `otpauth://` — the standard URI shape every authenticator app's
 * QR-scan/manual-entry path already understands (Google Authenticator, Authy,
 * 1Password, Microsoft Authenticator). Returned in the API response
 * alongside the raw secret so `ClinicianAdminPanel`-shaped future UI work
 * has something to render as a QR code without this module needing a
 * QR-image dependency of its own — generating the *code* is this file's
 * job, rendering it is a client concern.
 */
export function buildOtpauthUri(options: {
  readonly secretBase32: string;
  readonly accountName: string;
  readonly issuer: string;
}): string {
  const label = encodeURIComponent(`${options.issuer}:${options.accountName}`);
  const params = new URLSearchParams({
    secret: options.secretBase32,
    issuer: options.issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
