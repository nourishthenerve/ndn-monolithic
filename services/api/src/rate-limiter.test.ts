import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { InMemoryRateLimiter } from './rate-limiter.js';

class MutableClock implements Clock {
  private current: Date;

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return this.current;
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

describe('InMemoryRateLimiter', () => {
  it('allows up to the limit within a window, then blocks', async () => {
    const clock = new MutableClock(new Date('2026-08-10T09:00:00.000Z'));
    const limiter = new InMemoryRateLimiter({ clock, limit: 3, windowMs: 60_000 });

    expect(await limiter.tryConsume('principal-1')).toBe(true);
    expect(await limiter.tryConsume('principal-1')).toBe(true);
    expect(await limiter.tryConsume('principal-1')).toBe(true);
    expect(await limiter.tryConsume('principal-1')).toBe(false);
  });

  it('tracks each principal independently', async () => {
    const clock = new MutableClock(new Date('2026-08-10T09:00:00.000Z'));
    const limiter = new InMemoryRateLimiter({ clock, limit: 1, windowMs: 60_000 });

    expect(await limiter.tryConsume('principal-1')).toBe(true);
    expect(await limiter.tryConsume('principal-1')).toBe(false);
    expect(await limiter.tryConsume('principal-2')).toBe(true);
  });

  it('resets once the window elapses', async () => {
    const clock = new MutableClock(new Date('2026-08-10T09:00:00.000Z'));
    const limiter = new InMemoryRateLimiter({ clock, limit: 1, windowMs: 60_000 });

    expect(await limiter.tryConsume('principal-1')).toBe(true);
    expect(await limiter.tryConsume('principal-1')).toBe(false);

    clock.advanceMs(60_000);
    expect(await limiter.tryConsume('principal-1')).toBe(true);
  });
});
