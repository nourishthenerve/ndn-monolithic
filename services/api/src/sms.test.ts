import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { InMemorySmsFlagReader } from './sms-flags.js';
import { InMemoryRateLimiter } from './sms-rate-limiter.js';
import { InMemorySpendCounterStore, SMS_MONTHLY_CAP_PENCE } from './sms-spend-cap.js';
import { createSmsSender, type SendSmsParams } from './sms.js';

const fixedClock: Clock = { now: () => new Date('2026-08-10T09:00:00.000Z') };

const baseParams: SendSmsParams = {
  to: '+447911123456',
  template: 'appointment-reminder',
  vars: { time: '14:00' },
  principal: 'patient-1',
  costPence: 5,
};

function buildDeps(overrides: { enabled?: boolean; killSwitchEngaged?: boolean } = {}) {
  const flags = new InMemorySmsFlagReader({
    enabled: overrides.enabled ?? true,
    killSwitchEngaged: overrides.killSwitchEngaged ?? false,
  });
  const rateLimiter = new InMemoryRateLimiter({ clock: fixedClock, limit: 5, windowMs: 3_600_000 });
  const spendCounter = new InMemorySpendCounterStore();
  return { flags, rateLimiter, spendCounter, clock: fixedClock };
}

describe('createSmsSender', () => {
  it('sends when the flag is on, the destination is UK, and it is under the rate and spend caps', async () => {
    const deps = buildDeps();
    const sendSms = createSmsSender(deps);
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: true, status: 'Sent' });
  });

  it('is Blocked when sms.enabled is off (the default, safe state)', async () => {
    const deps = buildDeps({ enabled: false });
    const sendSms = createSmsSender(deps);
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'Blocked' });
  });

  it('is Blocked by the kill switch even when sms.enabled is on', async () => {
    const deps = buildDeps({ enabled: true, killSwitchEngaged: true });
    const sendSms = createSmsSender(deps);
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'Blocked' });
  });

  it('is NotUk for a non-UK destination, and does not consume a rate-limit slot', async () => {
    const deps = buildDeps();
    const sendSms = createSmsSender(deps);

    await expect(sendSms({ ...baseParams, to: '+12025550143' })).resolves.toEqual({
      ok: false,
      status: 'NotUk',
    });
    // The rejected attempt above must not have spent this principal's rate
    // budget — five more legitimate sends should still all succeed.
    for (let i = 0; i < 5; i += 1) {
      await expect(sendSms(baseParams)).resolves.toEqual({ ok: true, status: 'Sent' });
    }
  });

  it('is RateLimited once a principal exceeds its per-window allowance', async () => {
    const deps = buildDeps();
    deps.rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: 1,
      windowMs: 3_600_000,
    });
    const sendSms = createSmsSender(deps);

    await expect(sendSms(baseParams)).resolves.toEqual({ ok: true, status: 'Sent' });
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'RateLimited' });
  });

  it('is Capped once the monthly spend cap is reached, even for an otherwise-valid send', async () => {
    const deps = buildDeps();
    await deps.spendCounter.tryAdd('2026-08', SMS_MONTHLY_CAP_PENCE, SMS_MONTHLY_CAP_PENCE);
    const sendSms = createSmsSender(deps);

    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'Capped' });
  });
});
