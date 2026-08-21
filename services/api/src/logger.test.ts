import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { createSampledLogger, type RequestLogFields } from './logger.js';

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

  // TASK 2.1.2 (R-09): a log line is one of the four exits
  // docs/plan/09-self-audit.md's red-team names. RequestLogFields cannot
  // hold a record today, so these cast one in — the point is that a future
  // widening of the interface, or a caller spreading a record into it,
  // still cannot write clinical content to CloudWatch.
  describe('the private-field boundary', () => {
    const withPrivate = {
      ...fields,
      record: { visible: { painScore: 4 }, private: { clinicianNote: 'query non-organic' } },
    } as unknown as RequestLogFields;

    it('refuses a payload containing a private key', () => {
      const lines: string[] = [];
      const logger = createSampledLogger({
        clock: fixedClock,
        sampleRate: 1,
        random: () => 0,
        write: (line) => lines.push(line),
      });

      expect(() => logger.logRequest(withPrivate)).toThrow(AppError);
      expect(lines).toHaveLength(0);
    });

    it('refuses even when sampling would have dropped the line anyway', () => {
      // The check runs before the sample draw on purpose: a leak that only
      // shows up on the sampled 1-in-N request is a leak that reaches
      // production before anyone sees it.
      const lines: string[] = [];
      const logger = createSampledLogger({
        clock: fixedClock,
        sampleRate: 0,
        random: () => 0.9,
        write: (line) => lines.push(line),
      });

      expect(() => logger.logRequest(withPrivate)).toThrow(/carry a "private" attribute/);
      expect(lines).toHaveLength(0);
    });

    it('refuses a private key nested below the top level', () => {
      const logger = createSampledLogger({ clock: fixedClock, sampleRate: 1, random: () => 0 });
      const deep = {
        ...fields,
        page: { items: [{ private: { note: 'x' } }] },
      } as unknown as RequestLogFields;

      expect(() => logger.logRequest(deep)).toThrow(AppError);
    });

    it('still writes an ordinary line', () => {
      const lines: string[] = [];
      createSampledLogger({
        clock: fixedClock,
        sampleRate: 1,
        random: () => 0,
        write: (line) => lines.push(line),
      }).logRequest(fields);

      expect(lines).toHaveLength(1);
    });
  });
});
