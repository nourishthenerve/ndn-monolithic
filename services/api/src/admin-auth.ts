// TASK 1.3.2: docs/plan/05-execution-plan.md's own framing — Phase 2
// (Cognito/RBAC) doesn't exist yet (09-self-audit.md flags this ordering
// tension), so authoring needs *some* access control before G1. This is
// one narrow, explicitly-temporary bearer-token gate, not a real auth
// system: no user identity, no session, no scopes — just "did the caller
// present the one shared secret." content-authoring-handler.ts is the only
// place that resolves the real secret (SSM SecureString, D-14); this file
// stays pure and SDK-free so it's unit-testable without AWS.
//
// Superseded by Phase 2's Cognito RBAC — reused as-is by 1.4.2/1.5.1's own
// admin-gated endpoints in the meantime rather than reimplemented.
import { timingSafeEqual } from 'node:crypto';

const BEARER_PREFIX = 'Bearer ';

/** `undefined` for a missing/malformed header — never throws. */
export function extractBearerToken(header: string | undefined): string | undefined {
  if (!header || !header.startsWith(BEARER_PREFIX)) {
    return undefined;
  }
  const token = header.slice(BEARER_PREFIX.length);
  return token.length > 0 ? token : undefined;
}

/**
 * Constant-time comparison against `expectedToken`. A length mismatch is
 * checked first and returns false immediately — this leaks the *length* of
 * a rejected guess via timing, not any byte of the secret, which is the
 * same trade-off Node's own docs accept for `timingSafeEqual` (it throws
 * on mismatched-length buffers rather than comparing them).
 */
export function verifyAdminToken(header: string | undefined, expectedToken: string): boolean {
  const provided = extractBearerToken(header);
  if (!provided) {
    return false;
  }
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expectedToken);
  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(providedBuffer, expectedBuffer);
}
