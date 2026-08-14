import { describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import {
  CONTACT_FORM_RATE_LIMIT_PER_PRINCIPAL,
  CONTACT_FORM_RATE_LIMIT_WINDOW_MS,
  createContactFormHandler,
  type ContactFormDeps,
  type ContactRequest,
} from './contact-form.js';
import { InMemoryRateLimiter } from './rate-limiter.js';

const fixedClock: Clock = { now: () => new Date('2026-08-10T09:00:00.000Z') };

const baseRequest: ContactRequest = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'Hello there',
  turnstileToken: 'a-real-token',
  principal: 'hashed-principal-1',
};

function buildDeps(overrides: Partial<ContactFormDeps> = {}): ContactFormDeps & {
  verifyTurnstile: ReturnType<typeof vi.fn>;
  sendEmail: ReturnType<typeof vi.fn>;
} {
  return {
    verifyTurnstile: vi.fn().mockResolvedValue(true),
    rateLimiter: new InMemoryRateLimiter({
      clock: fixedClock,
      limit: CONTACT_FORM_RATE_LIMIT_PER_PRINCIPAL,
      windowMs: CONTACT_FORM_RATE_LIMIT_WINDOW_MS,
    }),
    sendEmail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as ContactFormDeps & {
    verifyTurnstile: ReturnType<typeof vi.fn>;
    sendEmail: ReturnType<typeof vi.fn>;
  };
}

describe('createContactFormHandler', () => {
  it('sends when Turnstile passes and the caller is under the rate limit', async () => {
    const deps = buildDeps();
    const handleContact = createContactFormHandler(deps);

    await expect(handleContact(baseRequest)).resolves.toEqual({ kind: 'sent' });
    expect(deps.sendEmail).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Hello there',
    });
  });

  it('is blocked/turnstile on a failed Turnstile check, and never calls sendEmail', async () => {
    const deps = buildDeps({ verifyTurnstile: vi.fn().mockResolvedValue(false) });
    const handleContact = createContactFormHandler(deps);

    await expect(handleContact(baseRequest)).resolves.toEqual({
      kind: 'blocked',
      reason: 'turnstile',
    });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('a Turnstile-rejected attempt does not consume a rate-limit slot', async () => {
    const rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: 1,
      windowMs: CONTACT_FORM_RATE_LIMIT_WINDOW_MS,
    });
    const deps = buildDeps({ verifyTurnstile: vi.fn().mockResolvedValue(false), rateLimiter });
    const handleContact = createContactFormHandler(deps);

    await handleContact(baseRequest);

    // The rate limiter still has its one slot free — a legitimate follow-up
    // submission (Turnstile now passing) must still succeed.
    const deps2 = buildDeps({ rateLimiter });
    await expect(createContactFormHandler(deps2)(baseRequest)).resolves.toEqual({ kind: 'sent' });
  });

  it('is blocked/rateLimited once a principal exceeds its per-window allowance, and never calls sendEmail on the blocked attempt', async () => {
    const rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: CONTACT_FORM_RATE_LIMIT_PER_PRINCIPAL,
      windowMs: CONTACT_FORM_RATE_LIMIT_WINDOW_MS,
    });
    const deps = buildDeps({ rateLimiter });
    const handleContact = createContactFormHandler(deps);

    await handleContact(baseRequest);
    await handleContact(baseRequest);
    await handleContact(baseRequest);
    deps.sendEmail.mockClear();

    await expect(handleContact(baseRequest)).resolves.toEqual({
      kind: 'blocked',
      reason: 'rateLimited',
    });
    expect(deps.sendEmail).not.toHaveBeenCalled();
  });

  it('tracks rate limits per principal independently', async () => {
    const rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: 1,
      windowMs: CONTACT_FORM_RATE_LIMIT_WINDOW_MS,
    });
    const deps = buildDeps({ rateLimiter });
    const handleContact = createContactFormHandler(deps);

    await expect(handleContact(baseRequest)).resolves.toEqual({ kind: 'sent' });
    await expect(handleContact(baseRequest)).resolves.toEqual({
      kind: 'blocked',
      reason: 'rateLimited',
    });
    await expect(
      handleContact({ ...baseRequest, principal: 'hashed-principal-2' }),
    ).resolves.toEqual({ kind: 'sent' });
  });
});
