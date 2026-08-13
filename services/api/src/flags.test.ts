import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';

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

describe('CachedFlagReader', () => {
  it('defaults an unset flag to false', async () => {
    const clock = new MutableClock(new Date('2026-08-13T09:00:00.000Z'));
    const reader = new CachedFlagReader({ source: new InMemoryFlagSource(), clock, ttlMs: 1000 });

    expect(await reader.isEnabled('sms.enabled')).toBe(false);
  });

  it('honours the TTL: serves a cached value until it elapses, then re-reads', async () => {
    const source = new InMemoryFlagSource();
    const clock = new MutableClock(new Date('2026-08-13T09:00:00.000Z'));
    const reader = new CachedFlagReader({ source, clock, ttlMs: 1000 });

    expect(await reader.isEnabled('sms.enabled')).toBe(false);

    source.set('sms.enabled', true);
    clock.advanceMs(999);
    expect(await reader.isEnabled('sms.enabled')).toBe(false);

    clock.advanceMs(1);
    expect(await reader.isEnabled('sms.enabled')).toBe(true);
  });

  it('caches each flag name independently', async () => {
    const source = new InMemoryFlagSource();
    source.set('sms.enabled', true);
    const clock = new MutableClock(new Date('2026-08-13T09:00:00.000Z'));
    const reader = new CachedFlagReader({ source, clock, ttlMs: 1000 });

    expect(await reader.isEnabled('sms.enabled')).toBe(true);
    expect(await reader.isEnabled('sms.killSwitchEngaged')).toBe(false);
  });
});
