import { describe, expect, it } from 'vitest';

import { deriveLoadTargets } from './derive-targets.js';

// TASK 5.1.1: this is the harness's own "guard's own test is the
// deliverable" line — the numbers here are what docs/runbooks/
// load-testing.md's Artillery YAML files hardcode, so a change to either
// side without the other is a real drift, not a rounding difference.
describe('deriveLoadTargets', () => {
  it('derives the 10x HTTP peak from the M12 cost-model volume', () => {
    const targets = deriveLoadTargets();

    // (500,000 / 220 active hours) * 3 peak-to-average * 10 = 68,181.8/hr
    // -> 18.94 req/s.
    expect(targets.httpRequestsPerSecond).toBeCloseTo(18.94, 1);
  });

  it('derives the 10x signalling peak and its steady-state concurrency from the M12 volume', () => {
    const targets = deriveLoadTargets();

    // (500 / 220 active hours) * 3 peak-to-average * 10 = 68.18 calls/hr.
    expect(targets.signallingConnectionsPerHour).toBeCloseTo(68.18, 1);
    // Little's Law: 68.18 calls/hr held open for the modelled 60
    // connection-minutes/call each = ~68 concurrent connections.
    expect(targets.signallingConcurrentConnections).toBeCloseTo(68.18, 1);
    expect(targets.signallingMessagesPerConnection).toBe(30);
  });
});
