import { describe, expect, it } from 'vitest';

import { InMemorySmsFlagReader } from './sms-flags.js';

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
