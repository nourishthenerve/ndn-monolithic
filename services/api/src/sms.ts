// TASK 0.5.3: assembles the guards in sms-flags.ts, sms-allow-list.ts,
// sms-rate-limiter.ts and sms-spend-cap.ts into the one function anything
// wanting to send an SMS must call.
//
// TASK 2.3.2 (ADR-0008): the sentence this header used to end on —
// "there is no code path here, in a test or otherwise, that can send a
// real SMS" — is no longer true. `createSmsSender` now calls
// `SmsProvider.send` once every existing guard has passed, at the end of
// the chain, in the same order this file already enforced; nothing above
// the provider call moved. A provider failure is caught rather than left
// to throw — every other branch here returns a typed result, never an
// exception, and `ProviderError` keeps that true so the caller (the
// Notifier, 2.3.1) degrades to email on a provider outage exactly the same
// way it does on `Capped`/`Blocked`/`NotUk`/`RateLimited`.
import type { Clock } from './clock.js';
import { normalizeUkE164 } from './sms-allow-list.js';
import type { SmsFlagReader } from './sms-flags.js';
import type { SmsProvider } from './sms-provider.js';
import type { RateLimiter } from './sms-rate-limiter.js';
import { currentMonthKey, SMS_MONTHLY_CAP_PENCE, type SpendCounterStore } from './sms-spend-cap.js';

export type SendSmsResult =
  | { readonly ok: true; readonly status: 'Sent' }
  | {
      readonly ok: false;
      readonly status: 'Blocked' | 'Capped' | 'NotUk' | 'RateLimited' | 'ProviderError';
    };

export interface SendSmsParams {
  readonly to: string;
  readonly template: string;
  readonly vars: Readonly<Record<string, string>>;
  /** The rendered SMS text — sms.ts renders nothing itself, it only ever forwards this. */
  readonly body: string;
  readonly principal: string;
  readonly costPence: number;
}

export interface SmsSenderDeps {
  readonly flags: SmsFlagReader;
  readonly rateLimiter: RateLimiter;
  readonly spendCounter: SpendCounterStore;
  readonly provider: SmsProvider;
  readonly clock: Clock;
}

export type SendSms = (params: SendSmsParams) => Promise<SendSmsResult>;

export function createSmsSender(deps: SmsSenderDeps): SendSms {
  return async (params) => {
    const flags = await deps.flags.read();
    if (!flags.enabled || flags.killSwitchEngaged) {
      return { ok: false, status: 'Blocked' };
    }

    const destination = normalizeUkE164(params.to);
    if (!destination) {
      return { ok: false, status: 'NotUk' };
    }

    const withinRate = await deps.rateLimiter.tryConsume(params.principal);
    if (!withinRate) {
      return { ok: false, status: 'RateLimited' };
    }

    const monthKey = currentMonthKey(deps.clock.now());
    const withinCap = await deps.spendCounter.tryAdd(
      monthKey,
      params.costPence,
      SMS_MONTHLY_CAP_PENCE,
    );
    if (!withinCap) {
      return { ok: false, status: 'Capped' };
    }

    try {
      await deps.provider.send({ to: destination, body: params.body });
    } catch {
      return { ok: false, status: 'ProviderError' };
    }

    return { ok: true, status: 'Sent' };
  };
}
