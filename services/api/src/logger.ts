// TASK 0.5.2 (R-11): the three log-shape rules docs/plan/00-conventions.md
// sets — "structured JSON, one line per request, sampled. No console.log.
// No debug level in production." Sampling matters once there's real
// traffic: CloudWatch Logs ingestion is billed per GB
// (docs/plan/02-risk-register.md, R-11), so a route hit continuously
// (an uptime monitor polling /health, a busy endpoint) would otherwise
// write a line per hit forever.
//
// TASK 2.1.2 (R-09): a log line is the second of the four exits
// docs/plan/09-self-audit.md's red-team names, and the one that leaks
// without anybody seeing it — CloudWatch is not a patient-facing surface,
// so a `private{}` attribute written here would sit there unnoticed. Every
// line is checked structurally before it is written, and the check runs
// *before* the sampling decision so a line that sampling would have
// dropped still fails loudly rather than passing by luck.
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { containsPrivateField } from './projection.js';

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
      // Refusing is deliberate: an unlogged request is a smaller failure
      // than a leaked clinical note (R-09 is the register's only Critical).
      // `level` is always 'info' below, so "no level may carry a private
      // field" and this one check are the same statement.
      if (containsPrivateField(fields)) {
        throw new AppError(
          'PRIVATE_FIELD_IN_LOG',
          `refusing to log route ${fields.route}: the log fields carry a "private" attribute`,
        );
      }
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
