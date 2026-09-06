import { describe, expect, it } from 'vitest';

import {
  CENTER_COLUMN,
  CENTER_OFFSET_DAYS,
  CENTER_ROW,
  dayKey,
  defaultSelectedDay,
  gridRange,
  groupByDay,
  isPastDay,
  isSameDay,
  shiftWindow,
  startOfDay,
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

describe('windowStartFor', () => {
  it('puts the anchor day in the middle square, not merely its week', () => {
    // The regression this module was rewritten for: centring the *week* left
    // today wherever its weekday happened to fall, which on a Sunday is the
    // last column of the middle row.
    const weeks = windowGrid(windowStartFor(TODAY));
    expect(isSameDay(weeks[CENTER_ROW]?.[CENTER_COLUMN] as Date, TODAY)).toBe(true);
  });

  it('centres on every weekday, not only the lucky one', () => {
    for (let offset = 0; offset < 7; offset += 1) {
      const anchor = local(2026, 8, 14 + offset);
      const weeks = windowGrid(windowStartFor(anchor));
      expect(isSameDay(weeks[CENTER_ROW]?.[CENTER_COLUMN] as Date, anchor)).toBe(true);
    }
  });

  it('opens on 17 days either side, symmetrically, whichever weekday today is', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    for (let offset = 0; offset < 7; offset += 1) {
      const anchor = local(2026, 8, 14 + offset);
      const days = windowGrid(windowStartFor(anchor)).flat();
      const first = startOfDay(days[0] as Date).getTime();
      const last = startOfDay(days[days.length - 1] as Date).getTime();
      const anchorDay = startOfDay(anchor).getTime();
      // The fortnight each way that was asked for, and the same amount each
      // way — the lopsided 20-behind/14-ahead of the week-aligned version is
      // exactly what this asserts is gone.
      expect((anchorDay - first) / DAY_MS).toBe(CENTER_OFFSET_DAYS);
      expect((last - anchorDay) / DAY_MS).toBe(CENTER_OFFSET_DAYS);
    }
  });

  it('spans five rows of seven around the anchor', () => {
    expect(WINDOW_WEEKS).toBe(5);
    const weeks = windowGrid(windowStartFor(TODAY));
    expect(weeks).toHaveLength(5);
    // Saturday 29 August through Friday 2 October — 17 days either side of
    // Tuesday the 15th, so the columns run Sat…Fri rather than Mon…Sun.
    expect(dayKey(weeks[0]?.[0] as Date)).toBe('2026-08-29');
    const lastWeek = weeks[weeks.length - 1] as readonly Date[];
    expect(dayKey(lastWeek[lastWeek.length - 1] as Date)).toBe('2026-10-02');
  });
});

describe('windowGrid', () => {
  it('starts every row on the same weekday, so the columns line up', () => {
    // Which weekday that is depends on the anchor — it is the anchor's own,
    // shifted back by `CENTER_OFFSET_DAYS`. What matters for the grid is only
    // that every row agrees, so a column means one weekday all the way down.
    const start = windowStartFor(TODAY);
    for (const week of windowGrid(start)) {
      expect(week[0]?.getDay()).toBe(start.getDay());
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
  it('moves whole weeks, so the columns keep their weekdays while paging', () => {
    // This is what stops the headers dancing on every press of the arrows:
    // only "Today" re-centres, and only re-centring can change which weekday
    // heads column one.
    const start = windowStartFor(TODAY);
    const shifted = shiftWindow(start, -WINDOW_STEP_WEEKS);
    expect(shifted.getDay()).toBe(start.getDay());
    expect(dayKey(shifted)).toBe('2026-08-15');
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
