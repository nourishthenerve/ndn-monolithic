// TASK 0.5.2 (R-11): the three log-shape rules docs/plan/00-conventions.md
// sets — "structured JSON, one line per request, sampled. No console.log.
// No debug level in production." Sampling matters once there's real
// traffic: CloudWatch Logs ingestion is billed per GB
// (docs/plan/02-risk-register.md, R-11), so a route hit continuously
// (an uptime monitor polling /health, a busy endpoint) would otherwise
// write a line per hit forever.
import type { Clock } from './clock.js';

export interface RequestLogFields {
  readonly requestId: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationMs: number;
}

export interface RequestLogger {
  logRequest(fields: RequestLogFields): void;
}

export interface SampledLoggerOptions {
  readonly clock: Clock;
  /** Fraction of requests to write, 0..1. */
  readonly sampleRate: number;
  /** Injectable so sampling decisions are deterministic in tests. */
  readonly random?: () => number;
  /** Injectable sink — defaults to stdout, which is what Lambda's log capture reads. */
  readonly write?: (line: string) => void;
}

export function createSampledLogger(options: SampledLoggerOptions): RequestLogger {
  if (options.sampleRate < 0 || options.sampleRate > 1) {
    throw new RangeError(`sampleRate must be between 0 and 1, got ${options.sampleRate}`);
  }
  const random = options.random ?? Math.random;
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));

  return {
    logRequest(fields) {
      if (random() >= options.sampleRate) return;
      // level is always 'info' — 00-conventions.md: "No debug level in
      // production," and this repo has no other environment.
      write(
        JSON.stringify({
          level: 'info',
          timestamp: options.clock.now().toISOString(),
          ...fields,
        }),
      );
    },
  };
}
