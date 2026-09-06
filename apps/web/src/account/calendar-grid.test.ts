import { describe, expect, it } from 'vitest';

import {
  dayKey,
  defaultSelectedDay,
  gridRange,
  groupByDay,
  isPastDay,
  isSameDay,
  shiftWindow,
  startOfDay,
  startOfWeek,
  WEEK_STARTS_ON,
  WEEKS_BEFORE,
  windowGrid,
  windowStartFor,
  WINDOW_STEP_WEEKS,
  WINDOW_WEEKS,
} from './calendar-grid.js';

// Every date here is built with the **local** `Date(y, m, d)` form and every
// assertion reads local components or a `dayKey`, so this suite passes in any
// timezone rather than only in the one CI happens to run in. An instant
// written as a literal `'2026-09-03T…Z'` would make half of these tests
// assert the machine's offset instead of the code.
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month, day, hour, minute);
}

function at(year: number, month: number, day: number, hour = 0, minute = 0): string {
  return local(year, month, day, hour, minute).toISOString();
}

/** 15 September 2026 is a Tuesday — a mid-week anchor, so off-by-one padding shows up. */
const TODAY = local(2026, 8, 15);

describe('startOfWeek', () => {
  it('walks back to the configured first day of the week', () => {
    // Tuesday 15 September 2026 -> Monday the 14th.
    expect(dayKey(startOfWeek(TODAY))).toBe('2026-09-14');
  });

  it('is the identity on a day that already starts a week', () => {
    const monday = local(2026, 8, 14);
    expect(dayKey(startOfWeek(monday))).toBe('2026-09-14');
  });

  it('crosses a month boundary backwards when it has to', () => {
    // Wednesday 1 July 2026 -> Monday 29 June.
    expect(dayKey(startOfWeek(local(2026, 6, 1)))).toBe('2026-06-29');
  });
});

describe('windowStartFor', () => {
  it('puts the anchor day\'s week in the middle row', () => {
    const weeks = windowGrid(windowStartFor(TODAY));
    const middle = weeks[WEEKS_BEFORE];
    expect(middle?.some((day) => isSameDay(day, TODAY))).toBe(true);
  });

  it('opens on exactly two weeks behind and two ahead', () => {
    expect(WINDOW_WEEKS).toBe(5);
    const weeks = windowGrid(windowStartFor(TODAY));
    expect(weeks).toHaveLength(5);
    // Monday 31 August through Sunday 4 October — the whole weeks either
    // side of Tuesday the 15th's own week.
    expect(dayKey(weeks[0]?.[0] as Date)).toBe('2026-08-31');
    const lastWeek = weeks[weeks.length - 1] as readonly Date[];
    expect(dayKey(lastWeek[lastWeek.length - 1] as Date)).toBe('2026-10-04');
  });

  it('reaches at least a fortnight in both directions, whichever weekday today is', () => {
    const FORTNIGHT_MS = 14 * 24 * 60 * 60 * 1000;
    for (let offset = 0; offset < 7; offset += 1) {
      const anchor = local(2026, 8, 14 + offset);
      const days = windowGrid(windowStartFor(anchor)).flat();
      const first = startOfDay(days[0] as Date).getTime();
      const last = startOfDay(days[days.length - 1] as Date).getTime();
      const anchorDay = startOfDay(anchor).getTime();
      expect(anchorDay - first).toBeGreaterThanOrEqual(FORTNIGHT_MS);
      expect(last - anchorDay).toBeGreaterThanOrEqual(FORTNIGHT_MS);
    }
  });
});

describe('windowGrid', () => {
  it('starts every row on the configured first day of the week', () => {
    for (const week of windowGrid(windowStartFor(TODAY))) {
      expect(week[0]?.getDay()).toBe(WEEK_STARTS_ON);
      expect(week).toHaveLength(7);
    }
  });

  it('runs consecutively, with no gap or repeat across the whole window', () => {
    const days = windowGrid(windowStartFor(TODAY)).flat();
    expect(days).toHaveLength(35);
    expect(new Set(days.map(dayKey)).size).toBe(35);
    for (let i = 1; i < days.length; i += 1) {
      const gap =
        startOfDay(days[i] as Date).getTime() - startOfDay(days[i - 1] as Date).getTime();
      // Days are compared at local midnight, so a DST transition inside the
      // window cannot make this 23 or 25 hours.
      expect(gap).toBe(24 * 60 * 60 * 1000);
    }
  });

  it('crosses a year boundary without special-casing', () => {
    const days = windowGrid(windowStartFor(local(2026, 11, 31))).flat();
    expect(days.some((day) => day.getFullYear() === 2027)).toBe(true);
    expect(days.some((day) => day.getFullYear() === 2026)).toBe(true);
  });
});

describe('shiftWindow', () => {
  it('moves whole weeks, so every row still starts on the same weekday', () => {
    const start = windowStartFor(TODAY);
    const shifted = shiftWindow(start, -WINDOW_STEP_WEEKS);
    expect(shifted.getDay()).toBe(WEEK_STARTS_ON);
    expect(dayKey(shifted)).toBe('2026-08-17');
  });

  it('keeps three of the five rows on screen, so a run of appointments is followed not jumped', () => {
    const before = windowGrid(windowStartFor(TODAY)).flat().map(dayKey);
    const after = windowGrid(shiftWindow(windowStartFor(TODAY), WINDOW_STEP_WEEKS))
      .flat()
      .map(dayKey);
    const overlap = after.filter((day) => before.includes(day));
    expect(overlap).toHaveLength((WINDOW_WEEKS - WINDOW_STEP_WEEKS) * 7);
  });

  it('is reversible, and the identity for a shift of zero', () => {
    const start = windowStartFor(TODAY);
    expect(dayKey(shiftWindow(shiftWindow(start, 4), -4))).toBe(dayKey(start));
    expect(dayKey(shiftWindow(start, 0))).toBe(dayKey(start));
  });

  it('crosses month and year boundaries', () => {
    expect(dayKey(shiftWindow(local(2026, 11, 28), 1))).toBe('2027-01-04');
    expect(dayKey(shiftWindow(local(2027, 0, 4), -1))).toBe('2026-12-28');
  });
});

describe('dayKey', () => {
  it('is the local calendar day, zero-padded', () => {
    expect(dayKey(local(2026, 8, 3))).toBe('2026-09-03');
    expect(dayKey(local(2026, 0, 1))).toBe('2026-01-01');
  });

  it('reads the local day even for an instant near midnight', () => {
    // The whole reason this is not `toISOString().slice(0, 10)`: at 23:30
    // local, that call returns *tomorrow* anywhere west of UTC, putting the
    // appointment in the wrong square.
    expect(dayKey(local(2026, 8, 3, 23, 30))).toBe('2026-09-03');
  });
});

describe('isPastDay', () => {
  it('compares whole days, so earlier today is not "past"', () => {
    expect(isPastDay(local(2026, 8, 15, 1, 0), local(2026, 8, 15, 23, 0))).toBe(false);
  });

  it('is true for yesterday and false for tomorrow', () => {
    expect(isPastDay(local(2026, 8, 14), TODAY)).toBe(true);
    expect(isPastDay(local(2026, 8, 16), TODAY)).toBe(false);
  });
});

describe('gridRange', () => {
  it('spans local midnight of the first square to local midnight after the last', () => {
    const weeks = windowGrid(windowStartFor(TODAY));
    const { from, to } = gridRange(weeks);
    const days = weeks.flat();
    const firstDay = days[0] as Date;
    const lastDay = days[days.length - 1] as Date;

    expect(new Date(from).getTime()).toBe(startOfDay(firstDay).getTime());
    expect(new Date(to).getTime()).toBe(
      local(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1).getTime(),
    );
  });

  it('is half-open, so an appointment late on the final day is inside it', () => {
    const weeks = windowGrid(windowStartFor(TODAY));
    const { to } = gridRange(weeks);
    const days = weeks.flat();
    const lastDay = days[days.length - 1] as Date;
    const lateOnLastDay = local(
      lastDay.getFullYear(),
      lastDay.getMonth(),
      lastDay.getDate(),
      23,
      59,
    );
    expect(lateOnLastDay.getTime()).toBeLessThan(new Date(to).getTime());
  });

  it('moves with the window, so scrolling back actually fetches the past', () => {
    const now = gridRange(windowGrid(windowStartFor(TODAY)));
    const earlier = gridRange(windowGrid(shiftWindow(windowStartFor(TODAY), -WINDOW_STEP_WEEKS)));
    expect(new Date(earlier.from).getTime()).toBeLessThan(new Date(now.from).getTime());
  });
});

describe('groupByDay', () => {
  const items = [
    { scheduledAt: at(2026, 8, 3, 16, 0) },
    { scheduledAt: at(2026, 8, 3, 9, 0) },
    { scheduledAt: at(2026, 8, 5, 11, 0) },
  ];

  it('buckets by the local day each instant falls on', () => {
    const byDay = groupByDay(items);
    expect([...byDay.keys()].sort()).toEqual(['2026-09-03', '2026-09-05']);
    expect(byDay.get('2026-09-03')).toHaveLength(2);
  });

  it('orders each day chronologically, whatever order they arrived in', () => {
    expect(groupByDay(items).get('2026-09-03')?.map((item) => item.scheduledAt)).toEqual([
      at(2026, 8, 3, 9, 0),
      at(2026, 8, 3, 16, 0),
    ]);
  });

  it('drops an unparseable instant rather than bucketing it under a NaN key', () => {
    const byDay = groupByDay([{ scheduledAt: 'not-a-date' }, ...items]);
    expect([...byDay.keys()].sort()).toEqual(['2026-09-03', '2026-09-05']);
  });

  it('is empty for no items', () => {
    expect(groupByDay([]).size).toBe(0);
  });
});

describe('defaultSelectedDay', () => {
  const weeks = windowGrid(windowStartFor(TODAY));

  it('picks today when today is on the grid, busy or not', () => {
    const byDay = groupByDay([{ scheduledAt: at(2026, 8, 20, 10, 0) }]);
    expect(defaultSelectedDay(weeks, byDay, TODAY)).toBe('2026-09-15');
  });

  it('picks the window\'s first busy day when today is elsewhere', () => {
    const byDay = groupByDay([
      { scheduledAt: at(2026, 8, 20, 10, 0) },
      { scheduledAt: at(2026, 8, 14, 10, 0) },
    ]);
    expect(defaultSelectedDay(weeks, byDay, local(2026, 1, 1))).toBe('2026-09-14');
  });

  it('will pick a busy day from either month the window straddles', () => {
    // A rolling window has no "outside month" to skip — 31 August is as much
    // part of this view as 15 September.
    const byDay = groupByDay([{ scheduledAt: at(2026, 7, 31, 10, 0) }]);
    expect(defaultSelectedDay(weeks, byDay, local(2026, 1, 1))).toBe('2026-08-31');
  });

  it('selects nothing at all for an empty window, rather than an arbitrary date', () => {
    expect(defaultSelectedDay(weeks, groupByDay([]), local(2026, 1, 1))).toBeUndefined();
  });
});

describe('isSameDay', () => {
  it('compares local days, not instants', () => {
    expect(isSameDay(local(2026, 8, 3, 1, 0), local(2026, 8, 3, 23, 0))).toBe(true);
    expect(isSameDay(local(2026, 8, 3), local(2026, 8, 4))).toBe(false);
  });

  it('distinguishes the same day number in a different month or year', () => {
    expect(isSameDay(local(2026, 8, 3), local(2026, 7, 3))).toBe(false);
    expect(isSameDay(local(2026, 8, 3), local(2025, 8, 3))).toBe(false);
  });
});
