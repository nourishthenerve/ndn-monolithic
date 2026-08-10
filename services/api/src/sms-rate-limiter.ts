// TASK 0.5.3 (R-02, NFR-09): step 4 — a per-principal rate limit, so one
// compromised or malicious principal can't burn the whole monthly cap
// (sms-spend-cap.ts) in a single burst before anyone notices.
import type { Clock } from './clock.js';

export interface RateLimiter {
  /** Returns whether `principal` is under its limit, consuming one slot if so. */
  tryConsume(principal: string): Promise<boolean>;
}

// SMS is reserved for the 1-hour appointment reminder (R-01) — one
// principal should never legitimately need more than a handful of sends
// per hour, so the default window and limit are deliberately tight.
export const SMS_RATE_LIMIT_PER_PRINCIPAL = 5;
export const SMS_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export interface FixedWindowRateLimiterOptions {
  readonly clock: Clock;
  readonly limit: number;
  readonly windowMs: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly windowStartMs = new Map<string, number>();
  private readonly counts = new Map<string, number>();

  constructor(private readonly options: FixedWindowRateLimiterOptions) {}

  async tryConsume(principal: string): Promise<boolean> {
    const now = this.options.clock.now().getTime();
    const start = this.windowStartMs.get(principal);
    if (start === undefined || now - start >= this.options.windowMs) {
      this.windowStartMs.set(principal, now);
      this.counts.set(principal, 1);
      return true;
    }
    const count = this.counts.get(principal) ?? 0;
    if (count >= this.options.limit) return false;
    this.counts.set(principal, count + 1);
    return true;
  }
}
