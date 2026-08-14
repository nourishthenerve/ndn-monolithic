// TASK 1.4.1: extracted from sms-rate-limiter.ts (TASK 0.5.3) — the
// fixed-window limiter was already principal-generic (`tryConsume(principal)`
// never assumed anything SMS-specific), so contact-form.ts reuses it
// directly for its own 3/hour-per-hashed-principal limit rather than a
// second implementation. sms-rate-limiter.ts re-exports everything here
// unchanged, so its own tests keep passing without modification.
import type { Clock } from './clock.js';

export interface RateLimiter {
  /** Returns whether `principal` is under its limit, consuming one slot if so. */
  tryConsume(principal: string): Promise<boolean>;
}

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
