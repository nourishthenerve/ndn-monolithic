import { describe, expect, it, vi } from 'vitest';

import type { Clock } from './clock.js';
import { InMemoryDeliveryLog, type DeliveryRecord } from './notification-log.js';
import { createNotifier, type EmailSend, type NotificationRecipient } from './notifications.js';
import { InMemorySmsFlagReader } from './sms-flags.js';
import type { SmsProvider } from './sms-provider.js';
import { InMemoryRateLimiter } from './sms-rate-limiter.js';
import { InMemorySpendCounterStore, SMS_MONTHLY_CAP_PENCE } from './sms-spend-cap.js';
import { createSmsSender } from './sms.js';

const fixedClock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const PATIENT: NotificationRecipient = {
  id: 'patient-1',
  email: 'patient@example.com',
  phone: '+447911123456',
  marketingOptIn: true,
};

// A stub, not a mock — this suite is about the Notifier's channel/
// degradation policy, not about what a real provider does with a message
// (sms-provider.test.ts covers that).
const stubProvider: SmsProvider = { send: async () => {} };

function buildSms(overrides: { enabled?: boolean; killSwitchEngaged?: boolean } = {}) {
  const flags = new InMemorySmsFlagReader({
    enabled: overrides.enabled ?? true,
    killSwitchEngaged: overrides.killSwitchEngaged ?? false,
  });
  const rateLimiter = new InMemoryRateLimiter({ clock: fixedClock, limit: 5, windowMs: 3_600_000 });
  const spendCounter = new InMemorySpendCounterStore();
  return createSmsSender({ flags, rateLimiter, spendCounter, provider: stubProvider, clock: fixedClock });
}

function build(overrides: { sendEmail?: EmailSend; sendSms?: ReturnType<typeof buildSms> } = {}) {
  const log = new InMemoryDeliveryLog();
  const sendEmail = overrides.sendEmail ?? (vi.fn(async () => {}) as EmailSend);
  const sendSms = overrides.sendSms ?? buildSms();
  const notifier = createNotifier({ sendEmail, sendSms, log, clock: fixedClock });
  return { log, sendEmail, sendSms, notifier };
}

describe('createNotifier — smsEligible template', () => {
  it('sends over SMS and records one "sent" delivery on the happy path', async () => {
    const { log, sendEmail, notifier } = build();

    const record = await notifier.send(PATIENT, 'appointmentReminder1Hour', { time: '14:00' });

    expect(record).toMatchObject({ channel: 'sms', outcome: 'sent' });
    expect(log.list()).toEqual([record]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  async function expectDegraded(sendSms: ReturnType<typeof buildSms>, expectedReason: string) {
    const { log, sendEmail, notifier } = build({ sendSms });
    const record = await notifier.send(PATIENT, 'appointmentReminder1Hour', { time: '14:00' });

    expect(record).toEqual({
      at: '2026-08-22T09:00:00.000Z',
      recipientId: 'patient-1',
      template: 'appointmentReminder1Hour',
      channel: 'email',
      outcome: 'degraded',
      reason: expectedReason,
    });
    expect(log.list()).toEqual([record]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  }

  it('degrades to email and names the reason when SMS is Blocked (the flag off)', async () => {
    await expectDegraded(buildSms({ enabled: false }), 'Blocked');
  });

  it('degrades to email and names the reason when SMS is Capped', async () => {
    const spendCounter = new InMemorySpendCounterStore();
    await spendCounter.tryAdd('2026-08', SMS_MONTHLY_CAP_PENCE, SMS_MONTHLY_CAP_PENCE);
    const sendSms = createSmsSender({
      flags: new InMemorySmsFlagReader({ enabled: true, killSwitchEngaged: false }),
      rateLimiter: new InMemoryRateLimiter({ clock: fixedClock, limit: 5, windowMs: 3_600_000 }),
      spendCounter,
      provider: stubProvider,
      clock: fixedClock,
    });

    await expectDegraded(sendSms, 'Capped');
  });

  it('degrades to email and names the reason when SMS is RateLimited', async () => {
    const rateLimiter = new InMemoryRateLimiter({ clock: fixedClock, limit: 1, windowMs: 3_600_000 });
    const sendSms = createSmsSender({
      flags: new InMemorySmsFlagReader({ enabled: true, killSwitchEngaged: false }),
      rateLimiter,
      spendCounter: new InMemorySpendCounterStore(),
      provider: stubProvider,
      clock: fixedClock,
    });
    // Exhaust this principal's window with an unrelated send first, so the
    // Notifier's own attempt below is the one that finds the limit spent —
    // matching how a real per-principal limit is reached (sms.test.ts's
    // own pattern), not an artificial limit of zero nothing could pass.
    await sendSms({
      to: PATIENT.phone as string,
      template: 'unrelated',
      vars: {},
      body: 'unrelated',
      principal: PATIENT.id,
      costPence: 5,
    });

    await expectDegraded(sendSms, 'RateLimited');
  });

  it('degrades to email and names the reason when the provider itself fails', async () => {
    const failingProvider: SmsProvider = {
      send: async () => {
        throw new Error('ThrottlingException');
      },
    };
    const sendSms = createSmsSender({
      flags: new InMemorySmsFlagReader({ enabled: true, killSwitchEngaged: false }),
      rateLimiter: new InMemoryRateLimiter({ clock: fixedClock, limit: 5, windowMs: 3_600_000 }),
      spendCounter: new InMemorySpendCounterStore(),
      provider: failingProvider,
      clock: fixedClock,
    });

    await expectDegraded(sendSms, 'ProviderError');
  });

  it('degrades to email with reason NotUk when the recipient has no phone', async () => {
    const { log, sendEmail, notifier } = build();
    const noPhone: NotificationRecipient = { ...PATIENT, phone: undefined };

    const record = await notifier.send(noPhone, 'appointmentReminder1Hour', { time: '14:00' });

    expect(record).toMatchObject({ channel: 'email', outcome: 'degraded', reason: 'NotUk' });
    expect(log.list()).toEqual([record]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('records "failed" when SMS is unavailable and the email fallback itself fails', async () => {
    const sendEmail: EmailSend = vi.fn(async () => {
      throw new Error('SES is down');
    });
    const sendSms = buildSms({ enabled: false });
    const { log, notifier } = build({ sendEmail, sendSms });

    const record = await notifier.send(PATIENT, 'appointmentReminder1Hour', { time: '14:00' });

    expect(record).toEqual({
      at: '2026-08-22T09:00:00.000Z',
      recipientId: 'patient-1',
      template: 'appointmentReminder1Hour',
      channel: 'email',
      outcome: 'failed',
      reason: 'EmailSendFailed',
    });
    expect(log.list()).toEqual([record]);
  });
});

describe('createNotifier — non-eligible template', () => {
  it('never reaches the SMS path, even with every SMS flag on', async () => {
    const sendSms = vi.fn(async () => ({ ok: true as const, status: 'Sent' as const }));
    const { log, notifier } = build({ sendSms: sendSms as ReturnType<typeof buildSms> });

    const record = await notifier.send(PATIENT, 'marketingNewsletter', { headline: 'News' });

    expect(sendSms).not.toHaveBeenCalled();
    expect(record.channel).toBe('email');
    expect(log.list()).toEqual([record]);
  });
});

describe('createNotifier — marketing preference', () => {
  it('silences a marketing template when the recipient has opted out, and records why', async () => {
    const { log, sendEmail, notifier } = build();
    const optedOut: NotificationRecipient = { ...PATIENT, marketingOptIn: false };

    const record = await notifier.send(optedOut, 'marketingNewsletter', { headline: 'News' });

    expect(record).toEqual({
      at: '2026-08-22T09:00:00.000Z',
      recipientId: 'patient-1',
      template: 'marketingNewsletter',
      channel: 'email',
      outcome: 'failed',
      reason: 'MarketingOptOut',
    });
    expect(log.list()).toEqual([record]);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not silence a clinical notification for the same opted-out recipient', async () => {
    const { sendEmail, notifier } = build();
    const optedOut: NotificationRecipient = { ...PATIENT, marketingOptIn: false };

    const record = await notifier.send(optedOut, 'appointmentReminder1Hour', { time: '14:00' });

    expect(record.outcome).not.toBe('failed');
    expect(record.reason).not.toBe('MarketingOptOut');
    // Delivered over SMS on the happy path — email is not this recipient's
    // fallback unless SMS itself is unavailable.
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe('createNotifier — the delivery record never carries PII or content', () => {
  it('contains no email address, phone number or message text on any branch', async () => {
    const cases: DeliveryRecord[] = [];
    const { log: happyLog, notifier: happyNotifier } = build();
    cases.push(await happyNotifier.send(PATIENT, 'appointmentReminder1Hour', { time: '14:00' }));

    const { notifier: optOutNotifier } = build();
    cases.push(
      await optOutNotifier.send({ ...PATIENT, marketingOptIn: false }, 'marketingNewsletter', {
        headline: 'A secret headline',
      }),
    );

    const { notifier: degradedNotifier } = build({ sendSms: buildSms({ enabled: false }) });
    cases.push(await degradedNotifier.send(PATIENT, 'appointmentReminder1Hour', { time: '14:00' }));

    for (const record of [...cases, ...happyLog.list()]) {
      const serialised = JSON.stringify(record);
      expect(serialised).not.toContain(PATIENT.email);
      expect(serialised).not.toContain(PATIENT.phone);
      expect(serialised).not.toContain('A secret headline');
      expect(serialised).not.toContain('14:00');
    }
  });
});
