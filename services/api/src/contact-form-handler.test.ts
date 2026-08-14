import { describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import { createContactFormHttpHandler, type ContactFormHttpDeps } from './contact-form-handler.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import { InMemoryRateLimiter } from './rate-limiter.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };

function fakeEvent(overrides: { body?: unknown; sourceIp?: string }) {
  return {
    routeKey: 'POST /contact',
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: overrides.sourceIp ?? '203.0.113.1' },
    },
  } as never;
}

function buildDeps(overrides: Partial<ContactFormHttpDeps> = {}) {
  const source = new InMemoryFlagSource();
  source.set('contact.form.enabled', true);
  const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
  const verifyTurnstile = vi.fn().mockResolvedValue(true);
  const sendEmail = vi.fn().mockResolvedValue(undefined);
  const rateLimiter = new InMemoryRateLimiter({ clock: fixedClock, limit: 3, windowMs: 3_600_000 });
  const deps: ContactFormHttpDeps = {
    flags,
    verifyTurnstile,
    rateLimiter,
    sendEmail,
    clock: fixedClock,
    ...overrides,
  };
  return { deps, verifyTurnstile, sendEmail };
}

const validBody = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'Hello there',
  turnstileToken: 'a-real-token',
};

describe('createContactFormHttpHandler — flag gating', () => {
  it('returns 404 when contact.form.enabled is off, without validating the body', async () => {
    const source = new InMemoryFlagSource();
    source.set('contact.form.enabled', false);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 });
    const { deps, verifyTurnstile } = buildDeps({ flags });
    const handler = createContactFormHttpHandler(deps);

    const result = await handler(fakeEvent({ body: {} }), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 404 });
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });
});

describe('createContactFormHttpHandler — body validation', () => {
  it('rejects a missing field with 400 before Turnstile is ever checked', async () => {
    const { deps, verifyTurnstile, sendEmail } = buildDeps();
    const handler = createContactFormHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: { name: 'Ada' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(verifyTurnstile).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('rejects an oversized field with 400 before Turnstile is ever checked', async () => {
    const { deps, verifyTurnstile } = buildDeps();
    const handler = createContactFormHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: { ...validBody, message: 'x'.repeat(5001) } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
    expect(verifyTurnstile).not.toHaveBeenCalled();
  });

  it('rejects an invalid email with 400', async () => {
    const { deps } = buildDeps();
    const handler = createContactFormHttpHandler(deps);

    const result = await handler(
      fakeEvent({ body: { ...validBody, email: 'not-an-email' } }),
      {} as never,
      undefined as never,
    );
    expect(result).toMatchObject({ statusCode: 400 });
  });

  it('rejects a missing body with 400', async () => {
    const { deps } = buildDeps();
    const handler = createContactFormHttpHandler(deps);

    const result = await handler(fakeEvent({}), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 400 });
  });
});

describe('createContactFormHttpHandler — happy path', () => {
  it('sends and returns 200 for a valid submission', async () => {
    const { deps, sendEmail } = buildDeps();
    const handler = createContactFormHttpHandler(deps);

    const result = await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 200 });
    expect(sendEmail).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Hello there',
    });
  });
});

describe('createContactFormHttpHandler — Turnstile gate', () => {
  it('returns 400 and never sends when Turnstile verification fails', async () => {
    const { deps, sendEmail } = buildDeps({ verifyTurnstile: vi.fn().mockResolvedValue(false) });
    const handler = createContactFormHttpHandler(deps);

    const result = await handler(fakeEvent({ body: validBody }), {} as never, undefined as never);
    expect(result).toMatchObject({ statusCode: 400 });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('createContactFormHttpHandler — rate limit gate', () => {
  it('returns 429 on a 4th submission within the window, from the same source IP', async () => {
    const { deps } = buildDeps();
    const handler = createContactFormHttpHandler(deps);
    const event = fakeEvent({ body: validBody });

    await handler(event, {} as never, undefined as never);
    await handler(event, {} as never, undefined as never);
    await handler(event, {} as never, undefined as never);
    const fourth = await handler(event, {} as never, undefined as never);

    expect(fourth).toMatchObject({ statusCode: 429 });
  });

  it('rate limits independently per source IP', async () => {
    const { deps } = buildDeps();
    const handler = createContactFormHttpHandler(deps);

    await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.1' }),
      {} as never,
      undefined as never,
    );
    await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.1' }),
      {} as never,
      undefined as never,
    );
    await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.1' }),
      {} as never,
      undefined as never,
    );
    const otherIpResult = await handler(
      fakeEvent({ body: validBody, sourceIp: '198.51.100.7' }),
      {} as never,
      undefined as never,
    );

    expect(otherIpResult).toMatchObject({ statusCode: 200 });
  });

  it('never puts the raw source IP in the response body', async () => {
    const { deps } = buildDeps();
    const handler = createContactFormHttpHandler(deps);

    const result = (await handler(
      fakeEvent({ body: validBody, sourceIp: '203.0.113.42' }),
      {} as never,
      undefined as never,
    )) as { body: string };

    expect(result.body).not.toContain('203.0.113.42');
  });
});
