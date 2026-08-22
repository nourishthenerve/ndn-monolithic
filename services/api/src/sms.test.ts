import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { InMemorySmsFlagReader } from './sms-flags.js';
import type { SmsProvider, SmsProviderSendParams } from './sms-provider.js';
import { InMemoryRateLimiter } from './sms-rate-limiter.js';
import { InMemorySpendCounterStore, SMS_MONTHLY_CAP_PENCE } from './sms-spend-cap.js';
import { createSmsSender, type SendSmsParams } from './sms.js';

const fixedClock: Clock = { now: () => new Date('2026-08-10T09:00:00.000Z') };

const baseParams: SendSmsParams = {
  to: '+447911123456',
  template: 'appointment-reminder',
  vars: { time: '14:00' },
  body: 'Reminder: your appointment is at 14:00 today.',
  principal: 'patient-1',
  costPence: 5,
};

class FakeSmsProvider implements SmsProvider {
  readonly calls: SmsProviderSendParams[] = [];
  private failWith: Error | undefined;

  async send(params: SmsProviderSendParams): Promise<void> {
    this.calls.push(params);
    if (this.failWith) {
      throw this.failWith;
    }
  }

  failNext(error: Error): void {
    this.failWith = error;
  }
}

function buildDeps(overrides: { enabled?: boolean; killSwitchEngaged?: boolean } = {}) {
  const flags = new InMemorySmsFlagReader({
    enabled: overrides.enabled ?? true,
    killSwitchEngaged: overrides.killSwitchEngaged ?? false,
  });
  const rateLimiter = new InMemoryRateLimiter({ clock: fixedClock, limit: 5, windowMs: 3_600_000 });
  const spendCounter = new InMemorySpendCounterStore();
  const provider = new FakeSmsProvider();
  return { flags, rateLimiter, spendCounter, provider, clock: fixedClock };
}

describe('createSmsSender', () => {
  it('sends when the flag is on, the destination is UK, and it is under the rate and spend caps', async () => {
    const deps = buildDeps();
    const sendSms = createSmsSender(deps);
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: true, status: 'Sent' });
  });

  it('calls the provider exactly once, with the normalised E.164 destination and the rendered body', async () => {
    const deps = buildDeps();
    const sendSms = createSmsSender(deps);

    await sendSms(baseParams);

    expect(deps.provider.calls).toEqual([
      { to: '+447911123456', body: 'Reminder: your appointment is at 14:00 today.' },
    ]);
  });

  it('is Blocked when sms.enabled is off (the default, safe state), and never reaches the provider', async () => {
    const deps = buildDeps({ enabled: false });
    const sendSms = createSmsSender(deps);
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'Blocked' });
    expect(deps.provider.calls).toHaveLength(0);
  });

  it('is Blocked by the kill switch even when sms.enabled is on', async () => {
    const deps = buildDeps({ enabled: true, killSwitchEngaged: true });
    const sendSms = createSmsSender(deps);
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'Blocked' });
    expect(deps.provider.calls).toHaveLength(0);
  });

  it('is NotUk for a non-UK destination, does not consume a rate-limit slot, and never reaches the provider', async () => {
    const deps = buildDeps();
    const sendSms = createSmsSender(deps);

    await expect(sendSms({ ...baseParams, to: '+12025550143' })).resolves.toEqual({
      ok: false,
      status: 'NotUk',
    });
    expect(deps.provider.calls).toHaveLength(0);
    // The rejected attempt above must not have spent this principal's rate
    // budget — five more legitimate sends should still all succeed.
    for (let i = 0; i < 5; i += 1) {
      await expect(sendSms(baseParams)).resolves.toEqual({ ok: true, status: 'Sent' });
    }
  });

  it('is RateLimited once a principal exceeds its per-window allowance, and never reaches the provider on that attempt', async () => {
    const deps = buildDeps();
    deps.rateLimiter = new InMemoryRateLimiter({
      clock: fixedClock,
      limit: 1,
      windowMs: 3_600_000,
    });
    const sendSms = createSmsSender(deps);

    await expect(sendSms(baseParams)).resolves.toEqual({ ok: true, status: 'Sent' });
    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'RateLimited' });
    expect(deps.provider.calls).toHaveLength(1);
  });

  it('is Capped once the monthly spend cap is reached, even for an otherwise-valid send, and never reaches the provider', async () => {
    const deps = buildDeps();
    await deps.spendCounter.tryAdd('2026-08', SMS_MONTHLY_CAP_PENCE, SMS_MONTHLY_CAP_PENCE);
    const sendSms = createSmsSender(deps);

    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'Capped' });
    expect(deps.provider.calls).toHaveLength(0);
  });

  it('is ProviderError when the provider throws — every existing guard had already passed', async () => {
    const deps = buildDeps();
    deps.provider.failNext(new Error('ThrottlingException'));
    const sendSms = createSmsSender(deps);

    await expect(sendSms(baseParams)).resolves.toEqual({ ok: false, status: 'ProviderError' });
    // The rate-limit slot and spend-cap amount were already committed
    // before the provider was called (step 4: "adds a call at the end of
    // that chain and moves nothing") — a provider outage does not refund
    // either, which is why R-01's mitigation is the Notifier degrading to
    // email, not a retry here.
    expect(deps.provider.calls).toHaveLength(1);
  });
});
