import { describe, expect, it } from 'vitest';

import { systemClock } from './clock.js';

describe('systemClock', () => {
  it('returns the current wall-clock time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
