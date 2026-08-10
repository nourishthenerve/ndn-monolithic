// TASK 0.5.3: assembles the guards in sms-flags.ts, sms-allow-list.ts,
// sms-rate-limiter.ts and sms-spend-cap.ts into the one function anything
// wanting to send an SMS must call. No SMS provider is wired in yet (ADR
// 0008: chosen at M2.2) — createSmsSender proves every rejection path holds
// and, on the happy path, commits the rate-limit and spend-cap state a real
// send would need to have committed, but it never calls a provider. There
// is no code path here — in a test or otherwise — that can send a real SMS.
import type { Clock } from './clock.js';
import { normalizeUkE164 } from './sms-allow-list.js';
import type { SmsFlagReader } from './sms-flags.js';
import type { RateLimiter } from './sms-rate-limiter.js';
import { currentMonthKey, SMS_MONTHLY_CAP_PENCE, type SpendCounterStore } from './sms-spend-cap.js';

export type SendSmsResult =
  | { readonly ok: true; readonly status: 'Sent' }
  | { readonly ok: false; readonly status: 'Blocked' | 'Capped' | 'NotUk' | 'RateLimited' };

export interface SendSmsParams {
  readonly to: string;
  readonly template: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly principal: string;
  readonly costPence: number;
}

export interface SmsSenderDeps {
  readonly flags: SmsFlagReader;
  readonly rateLimiter: RateLimiter;
  readonly spendCounter: SpendCounterStore;
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

    return { ok: true, status: 'Sent' };
  };
}
