import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import { GenericSmsFlagReader, InMemorySmsFlagReader } from './sms-flags.js';

const fixedClock: Clock = { now: () => new Date('2026-08-13T09:00:00.000Z') };

describe('InMemorySmsFlagReader', () => {
  it('defaults to the safe state: disabled, kill switch not engaged', async () => {
    const reader = new InMemorySmsFlagReader();
    await expect(reader.read()).resolves.toEqual({ enabled: false, killSwitchEngaged: false });
  });

  it('reflects a patch applied via set()', async () => {
    const reader = new InMemorySmsFlagReader();
    reader.set({ enabled: true });
    await expect(reader.read()).resolves.toEqual({ enabled: true, killSwitchEngaged: false });

    reader.set({ killSwitchEngaged: true });
    await expect(reader.read()).resolves.toEqual({ enabled: true, killSwitchEngaged: true });
  });

  it('accepts an explicit initial state', async () => {
    const reader = new InMemorySmsFlagReader({ enabled: true, killSwitchEngaged: false });
    await expect(reader.read()).resolves.toEqual({ enabled: true, killSwitchEngaged: false });
  });
});

describe('GenericSmsFlagReader', () => {
  it('defaults to the safe state when neither flag has ever been set', async () => {
    const source = new InMemoryFlagSource();
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 1000 });
    const reader = new GenericSmsFlagReader(flags);

    await expect(reader.read()).resolves.toEqual({ enabled: false, killSwitchEngaged: false });
  });

  it('reflects both flags from the underlying flag reader', async () => {
    const source = new InMemoryFlagSource();
    source.set('sms.enabled', true);
    source.set('sms.killSwitchEngaged', true);
    const flags = new CachedFlagReader({ source, clock: fixedClock, ttlMs: 1000 });
    const reader = new GenericSmsFlagReader(flags);

    await expect(reader.read()).resolves.toEqual({ enabled: true, killSwitchEngaged: true });
  });
});
