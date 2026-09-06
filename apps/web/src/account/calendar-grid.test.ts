import { describe, expect, it } from 'vitest';

import {
  dayKey,
  defaultSelectedDay,
  gridRange,
  groupByDay,
  isInMonth,
  isSameDay,
  monthGrid,
  monthOf,
  shiftMonth,
  startOfDay,
  WEEK_STARTS_ON,
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

describe('shiftMonth', () => {
  it('moves forward and back within a year', () => {
    expect(shiftMonth({ year: 2026, month: 8 }, 1)).toEqual({ year: 2026, month: 9 });
    expect(shiftMonth({ year: 2026, month: 8 }, -1)).toEqual({ year: 2026, month: 7 });
  });

  it('rolls over December and January — the two boundaries hand-rolled modulo gets wrong', () => {
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
  });

  it('handles a jump of more than a year in either direction', () => {
    expect(shiftMonth({ year: 2026, month: 5 }, 14)).toEqual({ year: 2027, month: 7 });
    expect(shiftMonth({ year: 2026, month: 5 }, -18)).toEqual({ year: 2024, month: 11 });
  });

  it('is the identity for a delta of zero', () => {
    expect(shiftMonth({ year: 2026, month: 5 }, 0)).toEqual({ year: 2026, month: 5 });
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
    const lateEvening = local(2026, 8, 3, 23, 30);
    expect(dayKey(lateEvening)).toBe('2026-09-03');
  });
});

describe('monthGrid', () => {
  it('starts every row on the configured first day of the week', () => {
    for (const week of monthGrid({ year: 2026, month: 8 })) {
      expect(week[0]?.getDay()).toBe(WEEK_STARTS_ON);
      expect(week).toHaveLength(7);
    }
  });

  it('covers every day of the month exactly once', () => {
    const days = monthGrid({ year: 2026, month: 8 }).flat();
    const inMonth = days.filter((day) => isInMonth(day, { year: 2026, month: 8 }));
    expect(inMonth).toHaveLength(30);
    expect(new Set(inMonth.map(dayKey)).size).toBe(30);
  });

  it('pads both ends with the neighbouring months rather than leaving gaps', () => {
    const weeks = monthGrid({ year: 2026, month: 8 });
    const days = weeks.flat();
    // 1 September 2026 is a Tuesday, so a Monday-first grid leads with one
    // day of August.
    expect(dayKey(days[0] as Date)).toBe('2026-08-31');
    expect(days.length % 7).toBe(0);
  });

  it('handles a leap February', () => {
    const days = monthGrid({ year: 2024, month: 1 })
      .flat()
      .filter((day) => isInMonth(day, { year: 2024, month: 1 }));
    expect(days).toHaveLength(29);
    expect(dayKey(days[days.length - 1] as Date)).toBe('2024-02-29');
  });

  it('uses exactly four rows for a February that starts on the first weekday', () => {
    // February 2027 has 28 days and begins on a Monday — the one shape that
    // needs no padding at all, and the case a fixed six-row grid would pad
    // with two entire empty weeks.
    expect(monthGrid({ year: 2027, month: 1 })).toHaveLength(4);
  });

  it('uses six rows when a 31-day month starts on the last day of the week', () => {
    // 1 March 2026 is a Sunday, so a Monday-first grid leads with six
    // padding days: 6 + 31 needs a sixth row. The widest a month can get.
    expect(monthGrid({ year: 2026, month: 2 })).toHaveLength(6);
  });
});

describe('gridRange', () => {
  it('spans local midnight of the first square to local midnight after the last', () => {
    const weeks = monthGrid({ year: 2026, month: 8 });
    const { from, to } = gridRange(weeks);
    const days = weeks.flat();
    const firstDay = days[0] as Date;
    const lastDay = days[days.length - 1] as Date;

    expect(new Date(from).getTime()).toBe(startOfDay(firstDay).getTime());
    expect(new Date(to).getTime()).toBe(
      local(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1).getTime(),
    );
  });

  it('covers the padding days, not just the month', () => {
    // A range clipped to the month itself would draw the leading and
    // trailing squares permanently empty however many appointments were in
    // them — the bug this function's own doc names.
    const weeks = monthGrid({ year: 2026, month: 8 });
    const { from } = gridRange(weeks);
    expect(new Date(from).getTime()).toBeLessThan(local(2026, 8, 1).getTime());
  });

  it('is half-open, so an appointment late on the final day is inside it', () => {
    const weeks = monthGrid({ year: 2026, month: 8 });
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
    const byDay = groupByDay(items);
    expect(byDay.get('2026-09-03')?.map((item) => item.scheduledAt)).toEqual([
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
  const month = { year: 2026, month: 8 };
  const weeks = monthGrid(month);

  it('picks today when today is on the grid, busy or not', () => {
    const byDay = groupByDay([{ scheduledAt: at(2026, 8, 20, 10, 0) }]);
    expect(defaultSelectedDay(weeks, month, byDay, local(2026, 8, 9))).toBe('2026-09-09');
  });

  it('picks the month\'s first busy day when today is elsewhere', () => {
    const byDay = groupByDay([
      { scheduledAt: at(2026, 8, 20, 10, 0) },
      { scheduledAt: at(2026, 8, 14, 10, 0) },
    ]);
    expect(defaultSelectedDay(weeks, month, byDay, local(2026, 1, 1))).toBe('2026-09-14');
  });

  it('ignores a busy padding day belonging to the neighbouring month', () => {
    // 31 August is drawn on September's grid; opening September and being
    // shown an August appointment would misreport which month you are in.
    const byDay = groupByDay([{ scheduledAt: at(2026, 7, 31, 10, 0) }]);
    expect(defaultSelectedDay(weeks, month, byDay, local(2026, 1, 1))).toBeUndefined();
  });

  it('selects nothing at all for an empty month, rather than an arbitrary date', () => {
    expect(defaultSelectedDay(weeks, month, groupByDay([]), local(2026, 1, 1))).toBeUndefined();
  });
});

describe('isSameDay / isInMonth / monthOf', () => {
  it('compares local days, not instants', () => {
    expect(isSameDay(local(2026, 8, 3, 1, 0), local(2026, 8, 3, 23, 0))).toBe(true);
    expect(isSameDay(local(2026, 8, 3), local(2026, 8, 4))).toBe(false);
  });

  it('distinguishes the same day number in a different month or year', () => {
    expect(isInMonth(local(2026, 8, 3), { year: 2026, month: 8 })).toBe(true);
    expect(isInMonth(local(2026, 7, 3), { year: 2026, month: 8 })).toBe(false);
    expect(isInMonth(local(2025, 8, 3), { year: 2026, month: 8 })).toBe(false);
  });

  it('reads a date back as its own month', () => {
    expect(monthOf(local(2026, 8, 3))).toEqual({ year: 2026, month: 8 });
  });
});
