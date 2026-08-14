// TASK 0.5.3 (R-02, NFR-09): step 4 — a per-principal rate limit, so one
// compromised or malicious principal can't burn the whole monthly cap
// (sms-spend-cap.ts) in a single burst before anyone notices.
//
// TASK 1.4.1: the fixed-window limiter itself moved to rate-limiter.ts —
// it was already principal-generic, so contact-form.ts reuses it directly
// rather than a second implementation. Re-exported here unchanged so every
// existing import of './sms-rate-limiter.js' keeps working with no
// behaviour change.
export type { FixedWindowRateLimiterOptions, RateLimiter } from './rate-limiter.js';
export { InMemoryRateLimiter } from './rate-limiter.js';

// SMS is reserved for the 1-hour appointment reminder (R-01) — one
// principal should never legitimately need more than a handful of sends
// per hour, so the default window and limit are deliberately tight.
export const SMS_RATE_LIMIT_PER_PRINCIPAL = 5;
export const SMS_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;
