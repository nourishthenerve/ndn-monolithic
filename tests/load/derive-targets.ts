// TASK 5.1.1: converts docs/plan/03-cost-model.md's own modelled MONTHLY
// volumes into a peak-CONCURRENT figure this harness can actually fire at a
// target — "prove the shape before building," the same discipline
// docs/adr/0002-database.md applies to a DynamoDB access pattern before any
// index exists, applied here to load for the first time. Every constant
// below cites the cost-model line it comes from; if that line's own number
// ever changes, this module's output changes with it, but the Artillery
// YAML scenario files under this same directory do not update themselves —
// docs/runbooks/load-testing.md names them as the one thing a maintainer
// must keep in sync by hand.

// docs/plan/03-cost-model.md's M12 (~500 patients) row.
export const M12_HTTP_REQUESTS_PER_MONTH = 500_000; // "API Gateway HTTP API"
export const M12_SIGNALLING_CALLS_PER_MONTH = 500; // "API Gateway WebSocket (signalling)"
export const MESSAGES_PER_CALL = 30; // same line's own "~30 messages ... each"
export const CONNECTION_MINUTES_PER_CALL = 60; // same line's own "~60 connection-min ... each"

// A clinic's real traffic is not spread evenly across the ~720 hours in a
// month — it concentrates in working hours. Modelled as 22 working days x
// 10 active hours/day, a conservative, named assumption rather than a 24/7
// average (which would understate every peak figure below). Named here so
// a reader can dispute the assumption directly rather than reverse-engineer
// it from the arithmetic.
export const ACTIVE_HOURS_PER_MONTH = 22 * 10;

// A commonly-cited rule of thumb for business-hour-concentrated traffic:
// the single busiest hour of the week runs at roughly 3x the active-hours
// average, not the same rate throughout. Applied uniformly to both figures
// below rather than picked differently per line.
export const PEAK_TO_AVERAGE_RATIO = 3;

// Gate G5's own criterion (docs/plan/06-gate-checklists.md): "load test at
// 10x."
export const LOAD_TEST_MULTIPLIER = 10;

function peakHourlyRate(monthlyVolume: number): number {
  return (monthlyVolume / ACTIVE_HOURS_PER_MONTH) * PEAK_TO_AVERAGE_RATIO;
}

export interface DerivedLoadTargets {
  readonly httpRequestsPerSecond: number;
  readonly signallingConnectionsPerHour: number;
  /**
   * Little's Law (L = λW): concurrent connections sustained at the 10x
   * peak arrival rate above, each held open for
   * CONNECTION_MINUTES_PER_CALL — the steady-state concurrency the
   * signalling scenario should ramp to and hold, not merely the arrival
   * rate alone.
   */
  readonly signallingConcurrentConnections: number;
  readonly signallingMessagesPerConnection: number;
}

export function deriveLoadTargets(): DerivedLoadTargets {
  const httpPeakHourly = peakHourlyRate(M12_HTTP_REQUESTS_PER_MONTH) * LOAD_TEST_MULTIPLIER;
  const signallingPeakHourly =
    peakHourlyRate(M12_SIGNALLING_CALLS_PER_MONTH) * LOAD_TEST_MULTIPLIER;

  return {
    httpRequestsPerSecond: httpPeakHourly / 3600,
    signallingConnectionsPerHour: signallingPeakHourly,
    signallingConcurrentConnections: signallingPeakHourly * (CONNECTION_MINUTES_PER_CALL / 60),
    signallingMessagesPerConnection: MESSAGES_PER_CALL,
  };
}
