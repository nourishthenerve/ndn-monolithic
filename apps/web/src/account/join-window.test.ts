// 2026-09-03: rewritten for the window the owner asked for — *"active from
// the start of the appointment to the whole duration upto which this
// appointment has been booked … before this appointment time show … in x
// days, y hours and z minutes and after the appointment slot time say
// 'expired'."*
//
// The old suite asserted a fixed 10-minute-early opening and said nothing
// about the end, because the old window had no notion of duration.
import { describe, expect, it } from 'vitest';

import {
  countdownUntil,
  formatCountdown,
  joinPhase,
  joinWindowClosesAt,
  parseScheduledAt,
} from './join-window.js';

const SCHEDULED_AT = new Date('2026-09-10T14:00:00.000Z');
const DURATION = 45;

const UNITS = {
  day: 'day',
  days: 'days',
  hour: 'hour',
  hours: 'hours',
  minute: 'minute',
  minutes: 'minutes',
  and: 'and',
};

function at(iso: string): Date {
  return new Date(iso);
}

describe('parseScheduledAt', () => {
  it('reads the scheduledAt half of a composite appointment id', () => {
    expect(parseScheduledAt('pat-1#2026-09-10T14:00:00.000Z')?.toISOString()).toBe(
      '2026-09-10T14:00:00.000Z',
    );
  });

  it.each(['', 'no-separator', '#2026-09-10T14:00:00.000Z', 'pat-1#', 'pat-1#not-a-date'])(
    'refuses %s',
    (id) => {
      expect(parseScheduledAt(id)).toBeUndefined();
    },
  );
});

describe('joinWindowClosesAt', () => {
  it('is the start plus the booked duration, not a fixed grace period', () => {
    expect(joinWindowClosesAt(SCHEDULED_AT, DURATION).toISOString()).toBe(
      '2026-09-10T14:45:00.000Z',
    );
  });

  it('gives a longer appointment a longer window', () => {
    // The whole point of the change: a 15-minute check-in and a 90-minute
    // assessment used to get the identical fixed window.
    expect(joinWindowClosesAt(SCHEDULED_AT, 15).toISOString()).toBe('2026-09-10T14:15:00.000Z');
    expect(joinWindowClosesAt(SCHEDULED_AT, 90).toISOString()).toBe('2026-09-10T15:30:00.000Z');
  });
});

describe('joinPhase', () => {
  it.each([
    ['a day before', '2026-09-09T14:00:00.000Z', 'before'],
    ['a minute before', '2026-09-10T13:59:00.000Z', 'before'],
    ['one millisecond before', '2026-09-10T13:59:59.999Z', 'before'],
    ['exactly at the start', '2026-09-10T14:00:00.000Z', 'open'],
    ['midway through', '2026-09-10T14:22:00.000Z', 'open'],
    ['one millisecond before the end', '2026-09-10T14:44:59.999Z', 'open'],
    ['exactly at the end', '2026-09-10T14:45:00.000Z', 'expired'],
    ['an hour after', '2026-09-10T15:00:00.000Z', 'expired'],
  ])('is %s → %s', (_label, now, expected) => {
    expect(joinPhase(SCHEDULED_AT, DURATION, at(now))).toBe(expected);
  });

  it('opens at the start, with no early grace — the instruction was explicit', () => {
    // Reinstating a grace period is one subtraction here and the matching
    // one in `ws-join.ts`; recorded so the absence reads as a decision.
    expect(joinPhase(SCHEDULED_AT, DURATION, at('2026-09-10T13:50:00.000Z'))).toBe('before');
  });
});

describe('countdownUntil', () => {
  it.each([
    ['2026-09-08T11:30:00.000Z', { days: 2, hours: 2, minutes: 30 }],
    ['2026-09-10T12:00:00.000Z', { days: 0, hours: 2, minutes: 0 }],
    ['2026-09-10T13:55:00.000Z', { days: 0, hours: 0, minutes: 5 }],
  ])('splits the remaining time at %s', (now, expected) => {
    expect(countdownUntil(SCHEDULED_AT, at(now))).toEqual(expected);
  });

  it('is undefined once the appointment has started', () => {
    expect(countdownUntil(SCHEDULED_AT, SCHEDULED_AT)).toBeUndefined();
    expect(countdownUntil(SCHEDULED_AT, at('2026-09-10T14:30:00.000Z'))).toBeUndefined();
  });

  it('never counts down to zero minutes while there is still time to wait', () => {
    // 20 seconds left is still a wait. "in 0 minutes" beside a button that
    // does not work yet is the one output this must not produce.
    expect(countdownUntil(SCHEDULED_AT, at('2026-09-10T13:59:40.000Z'))).toEqual({
      days: 0,
      hours: 0,
      minutes: 1,
    });
  });

  it('rounds the total before splitting, so it cannot produce 60 minutes', () => {
    // 1h 59m 30s. Rounding the minutes component alone would give
    // "1 hour and 60 minutes".
    expect(countdownUntil(SCHEDULED_AT, at('2026-09-10T12:00:30.000Z'))).toEqual({
      days: 0,
      hours: 2,
      minutes: 0,
    });
  });
});

describe('formatCountdown', () => {
  it('reads as the owner asked — x days, y hours and z minutes', () => {
    expect(formatCountdown({ days: 2, hours: 3, minutes: 15 }, UNITS)).toBe(
      '2 days, 3 hours and 15 minutes',
    );
  });

  it('drops leading zero units', () => {
    // "in 0 days, 0 hours and 5 minutes" is worst exactly when it matters
    // most: the last few minutes before a call.
    expect(formatCountdown({ days: 0, hours: 0, minutes: 5 }, UNITS)).toBe('5 minutes');
    expect(formatCountdown({ days: 0, hours: 2, minutes: 5 }, UNITS)).toBe('2 hours and 5 minutes');
  });

  it('keeps a zero unit once something larger has been printed', () => {
    expect(formatCountdown({ days: 1, hours: 0, minutes: 5 }, UNITS)).toBe(
      '1 day, 0 hours and 5 minutes',
    );
  });

  it('singularises each unit independently', () => {
    expect(formatCountdown({ days: 1, hours: 1, minutes: 1 }, UNITS)).toBe(
      '1 day, 1 hour and 1 minute',
    );
  });
});
