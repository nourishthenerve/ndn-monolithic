import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { createSampledLogger } from './logger.js';

const fixedClock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const fields = { requestId: 'req-1', route: '/health', statusCode: 200, durationMs: 12 };

describe('createSampledLogger', () => {
  it('writes a single structured JSON line when the sample draw is under the rate', () => {
    const lines: string[] = [];
    const logger = createSampledLogger({
      clock: fixedClock,
      sampleRate: 0.5,
      random: () => 0.4,
      write: (line) => lines.push(line),
    });

    logger.logRequest(fields);

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: 'info',
      timestamp: '2026-01-01T00:00:00.000Z',
      ...fields,
    });
  });

  it('drops the line when the sample draw lands at or above the rate', () => {
    const lines: string[] = [];
    const logger = createSampledLogger({
      clock: fixedClock,
      sampleRate: 0.5,
      random: () => 0.5,
      write: (line) => lines.push(line),
    });

    logger.logRequest(fields);

    expect(lines).toHaveLength(0);
  });

  it('always writes at sampleRate 1 and never writes at sampleRate 0', () => {
    const alwaysLines: string[] = [];
    const neverLines: string[] = [];

    createSampledLogger({
      clock: fixedClock,
      sampleRate: 1,
      random: () => 0.999999,
      write: (line) => alwaysLines.push(line),
    }).logRequest(fields);
    createSampledLogger({
      clock: fixedClock,
      sampleRate: 0,
      random: () => 0,
      write: (line) => neverLines.push(line),
    }).logRequest(fields);

    expect(alwaysLines).toHaveLength(1);
    expect(neverLines).toHaveLength(0);
  });

  it('rejects a sample rate outside 0..1', () => {
    expect(() => createSampledLogger({ clock: fixedClock, sampleRate: 1.5 })).toThrow(RangeError);
    expect(() => createSampledLogger({ clock: fixedClock, sampleRate: -0.1 })).toThrow(
      RangeError,
    );
  });

  it('defaults to writing to stdout when no sink is injected', () => {
    const logger = createSampledLogger({ clock: fixedClock, sampleRate: 1, random: () => 0 });
    expect(() => logger.logRequest(fields)).not.toThrow();
  });
});
