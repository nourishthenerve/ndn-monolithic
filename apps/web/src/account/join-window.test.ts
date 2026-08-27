// TASK 4.5.1. Deliberately does not import `VideoCall.tsx` — see
// `join-window.ts`'s own header for why the split exists.
import { describe, expect, it } from 'vitest';

import {
  JOIN_WINDOW_OPENS_BEFORE_MINUTES,
  joinWindowOpensAt,
  minutesUntilJoinWindowOpens,
  parseScheduledAt,
} from './join-window.js';

describe('parseScheduledAt', () => {
  it('parses the ISO timestamp half of a real appointmentId', () => {
    const result = parseScheduledAt('pat-1#2026-09-01T10:00:00.000Z');
    expect(result).toEqual(new Date('2026-09-01T10:00:00.000Z'));
  });

  it('is undefined for an id with no separator at all', () => {
    expect(parseScheduledAt('not-a-real-id')).toBeUndefined();
  });

  it('is undefined when the patient half is empty', () => {
    expect(parseScheduledAt('#2026-09-01T10:00:00.000Z')).toBeUndefined();
  });

  it('is undefined when nothing follows the separator', () => {
    expect(parseScheduledAt('pat-1#')).toBeUndefined();
  });

  it('is undefined when the second half is not a real date, never throwing', () => {
    expect(parseScheduledAt('pat-1#not-a-date')).toBeUndefined();
  });
});

describe('joinWindowOpensAt', () => {
  it("opens JOIN_WINDOW_OPENS_BEFORE_MINUTES before scheduledAt", () => {
    const scheduledAt = new Date('2026-09-01T10:00:00.000Z');
    expect(joinWindowOpensAt(scheduledAt)).toEqual(new Date('2026-09-01T09:50:00.000Z'));
  });

  it('mirrors ws-join.ts\'s own named constant, not a magic number', () => {
    expect(JOIN_WINDOW_OPENS_BEFORE_MINUTES).toBe(10);
  });
});

describe('minutesUntilJoinWindowOpens', () => {
  it('is undefined once the window is already open', () => {
    const opensAt = new Date('2026-09-01T09:50:00.000Z');
    expect(minutesUntilJoinWindowOpens(opensAt, opensAt)).toBeUndefined();
  });

  it('is undefined once the window has been open for a while', () => {
    const opensAt = new Date('2026-09-01T09:50:00.000Z');
    const now = new Date('2026-09-01T10:00:00.000Z');
    expect(minutesUntilJoinWindowOpens(opensAt, now)).toBeUndefined();
  });

  it('rounds up to the nearest whole minute', () => {
    const opensAt = new Date('2026-09-01T09:50:00.000Z');
    const now = new Date('2026-09-01T09:45:30.000Z'); // 4.5 minutes away
    expect(minutesUntilJoinWindowOpens(opensAt, now)).toBe(5);
  });

  it('never reports zero minutes in the moments just before opening', () => {
    const opensAt = new Date('2026-09-01T09:50:00.000Z');
    const now = new Date('2026-09-01T09:49:59.900Z'); // 100ms away
    expect(minutesUntilJoinWindowOpens(opensAt, now)).toBe(1);
  });

  it('reports a real figure for a caller hours early', () => {
    const opensAt = new Date('2026-09-01T09:50:00.000Z');
    const now = new Date('2026-09-01T07:50:00.000Z'); // 2 hours away
    expect(minutesUntilJoinWindowOpens(opensAt, now)).toBe(120);
  });
});
