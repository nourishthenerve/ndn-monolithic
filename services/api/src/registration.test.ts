// TASK 2.2.3 step 7, and the disclosure property that goes with it.
import { describe, expect, it, vi } from 'vitest';

import type { FlagReader } from './flags.js';
import type { RateLimiter } from './rate-limiter.js';
import {
  createRegistration,
  PATIENT_REGISTRATION_FLAG,
  type IntakeStore,
  type RegistrationIntake,
  type SignUpPort,
} from './registration.js';

const REQUEST = {
  email: 'patient@example.com',
  fullName: 'A Patient',
  phone: '+441234567890',
  marketingOptIn: true,
  turnstileToken: 'token',
};

const IP_HASH = 'a'.repeat(64);

function flags(enabled: boolean): FlagReader {
  return { isEnabled: async (name) => (name === PATIENT_REGISTRATION_FLAG ? enabled : false) };
}

function build(overrides: {
  enabled?: boolean;
  turnstile?: boolean;
  allowed?: boolean;
  signUpOutcome?: 'created' | 'exists';
} = {}) {
  const puts: [string, RegistrationIntake][] = [];
  const intake: IntakeStore = {
    put: async (subjectId, value) => void puts.push([subjectId, value]),
    take: async () => undefined,
  };
  const signUp = vi.fn(async () =>
    overrides.signUpOutcome === 'exists'
      ? ({ outcome: 'exists' } as const)
      : ({ outcome: 'created', subjectId: 'sub-1' } as const),
  );
  const tryConsume = vi.fn(async () => overrides.allowed ?? true);
  const rateLimiter: RateLimiter = { tryConsume };
  const verifyTurnstile = vi.fn(async () => overrides.turnstile ?? true);

  const register = createRegistration({
    flags: flags(overrides.enabled ?? true),
    verifyTurnstile,
    rateLimiter,
    signUp: { signUp } as SignUpPort,
    intake,
  });
  return { register, puts, signUp, tryConsume, verifyTurnstile };
}

describe('the flag is the outermost gate', () => {
  it('answers disabled before Turnstile is checked or the limiter is touched', async () => {
    const { register, verifyTurnstile, tryConsume, signUp } = build({ enabled: false });

    expect(await register(REQUEST, IP_HASH)).toEqual({ kind: 'disabled' });
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(tryConsume).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
  });
});

describe('the gates run in order', () => {
  it('rejects on Turnstile without spending a rate-limit slot', async () => {
    // The limiter's budget belongs to humans. A bot that fails the
    // challenge must not be able to exhaust a real visitor's allowance.
    const { register, tryConsume, signUp } = build({ turnstile: false });

    expect(await register(REQUEST, IP_HASH)).toEqual({ kind: 'blocked', reason: 'turnstile' });
    expect(tryConsume).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
  });

  it('rejects on the rate limit without creating an account', async () => {
    const { register, signUp } = build({ allowed: false });

    expect(await register(REQUEST, IP_HASH)).toEqual({ kind: 'blocked', reason: 'rateLimited' });
    expect(signUp).not.toHaveBeenCalled();
  });

  it('keys the limiter on the hashed address it was given, never a raw one', async () => {
    const { register, tryConsume } = build();
    await register(REQUEST, IP_HASH);

    expect(tryConsume).toHaveBeenCalledWith(IP_HASH);
  });
});

describe('what a successful registration does and does not reveal', () => {
  it('signs up with the address and parks the rest under the returned sub', async () => {
    const { register, puts, signUp } = build();

    expect(await register(REQUEST, IP_HASH)).toEqual({ kind: 'accepted' });
    expect(signUp).toHaveBeenCalledWith('patient@example.com');
    expect(puts).toEqual([
      [
        'sub-1',
        {
          fullName: 'A Patient',
          email: 'patient@example.com',
          phone: '+441234567890',
          marketingOptIn: true,
        },
      ],
    ]);
  });

  it('answers identically for an address that is already registered', async () => {
    // Otherwise this endpoint is an oracle for "is this person a patient
    // at a neuro-rehabilitation clinic" — the disclosure TASK 2.2.1's
    // preventUserExistenceErrors exists to prevent, undone by our own API.
    const fresh = build();
    const existing = build({ signUpOutcome: 'exists' });

    expect(await existing.register(REQUEST, IP_HASH)).toEqual(
      await fresh.register(REQUEST, IP_HASH),
    );
  });

  it('parks no intake row for an address that already exists', async () => {
    // There is already a `sub` for that address and it is not ours to
    // overwrite; the first registration's intake row still stands.
    const { register, puts } = build({ signUpOutcome: 'exists' });
    await register(REQUEST, IP_HASH);

    expect(puts).toEqual([]);
  });

  it('never puts the patient name into anything but the intake row', async () => {
    const { register, puts, signUp } = build();
    await register(REQUEST, IP_HASH);

    expect(JSON.stringify(signUp.mock.calls)).not.toContain('A Patient');
    expect(puts[0]?.[1].fullName).toBe('A Patient');
  });
});
