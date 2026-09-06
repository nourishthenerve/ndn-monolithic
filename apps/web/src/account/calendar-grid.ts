// 2026-09-06: the date arithmetic behind the dashboard's month calendar.
//
// The owner: *"At the very top I want to show calender not the form of a
// list of all past and future appointments but as literally a calender where
// the patient/clinician/principal clinician can scroll left and right to see
// all past and upcoming appointments."*
//
// Every function here is pure and takes its own clock, so the grid, the
// fetch window and the grouping can be tested without a DOM, a timer or a
// network — the component that uses them (`AppointmentCalendar.tsx`) is then
// left with rendering and fetching only.
//
// ## The one decision that runs through all of it: days are *local*
//
// `scheduledAt` is a UTC ISO-8601 instant. Which square of a calendar it
// belongs in is a question about the reader's own timezone, not about UTC —
// a 00:30 UTC appointment is the 3rd in London and still the 2nd in New
// York, and `packages/i18n/src/datetime.ts` already prints it in the
// reader's zone. A grid keyed on UTC dates would therefore put appointments
// in squares whose printed times sit in the neighbouring one.
//
// So every date here is constructed with the local `Date(y, m, d)` form and
// read back with the local `getFullYear`/`getMonth`/`getDate` accessors, and
// `gridRange` converts to UTC only at the boundary, where the API needs it.

/**
 * ISO-8601's own first day of the week, matching `Date.prototype.getDay`'s
 * numbering. The clinic is UK-based and the site ships one locale (`en`);
 * `Intl.Locale.prototype.getWeekInfo` would derive this properly but is
 * still not in every browser this site supports, so it is a named constant
 * — the single place to change when a locale that starts on Sunday ships.
 */
export const WEEK_STARTS_ON = 1;

export const DAYS_IN_WEEK = 7;

export interface CalendarMonth {
  readonly year: number;
  /** 0-11, matching `Date.prototype.getMonth` rather than human numbering. */
  readonly month: number;
}

export function monthOf(date: Date): CalendarMonth {
  return { year: date.getFullYear(), month: date.getMonth() };
}

/**
 * The month `delta` months away — this is what "scroll left and right" is.
 *
 * No wrap arithmetic: `new Date(y, m + delta, 1)` normalises an out-of-range
 * month itself, so month 12 becomes January of the next year and month -1
 * becomes December of the previous one. Hand-rolled modulo here is a classic
 * source of off-by-one-year bugs at exactly the two boundaries nobody tests.
 */
export function shiftMonth(month: CalendarMonth, delta: number): CalendarMonth {
  return monthOf(new Date(month.year, month.month + delta, 1));
}

/** The first instant of a local calendar day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * A local calendar day as `YYYY-MM-DD` — the key both the grid and the
 * grouped appointments are looked up by.
 *
 * Built by hand rather than with `toISOString().slice(0, 10)`, which would
 * convert to UTC first and hand back the wrong day for anyone east or west
 * of it — the exact bug this module's header exists to prevent.
 */
export function dayKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function isSameDay(a: Date, b: Date): boolean {
  return dayKey(a) === dayKey(b);
}

export function isInMonth(date: Date, month: CalendarMonth): boolean {
  return date.getFullYear() === month.year && date.getMonth() === month.month;
}

/**
 * The weeks a month is drawn as: whole weeks, starting on `WEEK_STARTS_ON`,
 * padded at both ends with the neighbouring months' days so every row has
 * seven cells.
 *
 * The row count is derived, not fixed at six. A fixed six-row grid keeps the
 * calendar's height stable between months, which is a real benefit — but it
 * also renders up to a whole empty week of the *next* month, and on the
 * narrow layout this component has to work in, that is a screenful of
 * nothing between the grid and the day panel below it.
 */
export function monthGrid(month: CalendarMonth): readonly (readonly Date[])[] {
  // Day 0 of the following month is the last day of this one — the standard
  // way to ask JavaScript how long a month is without a leap-year table.
  const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
  const firstWeekday = new Date(month.year, month.month, 1).getDay();
  const lead = (firstWeekday - WEEK_STARTS_ON + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  const weekCount = Math.ceil((lead + daysInMonth) / DAYS_IN_WEEK);

  return Array.from({ length: weekCount }, (_unusedWeek, week) =>
    Array.from(
      { length: DAYS_IN_WEEK },
      // A day number below 1 or above the month's length is not an error
      // here: `Date` rolls it into the neighbouring month, which is exactly
      // the padding this grid wants.
      (_unusedDay, day) =>
        new Date(month.year, month.month, 1 - lead + week * DAYS_IN_WEEK + day),
    ),
  );
}

/**
 * The UTC instants spanning everything a grid can show, for the ranged
 * `GET /clinicians/me/calendar?from=&to=`.
 *
 * Spans the **whole grid**, not the whole month, and that is not a detail:
 * the first and last rows carry days from the neighbouring months, and a
 * range clipped to the month itself would draw those squares permanently
 * empty however many appointments were in them.
 *
 * `to` is the start of the day *after* the last one — a half-open interval,
 * so an appointment at 23:59 on the final square is inside the range and no
 * arithmetic on "the last millisecond of the day" is needed.
 */
export function gridRange(weeks: readonly (readonly Date[])[]): {
  readonly from: string;
  readonly to: string;
} {
  const firstDay = weeks[0]?.[0];
  const lastWeek = weeks[weeks.length - 1];
  const lastDay = lastWeek?.[lastWeek.length - 1];
  if (!firstDay || !lastDay) {
    // An empty grid is not reachable from `monthGrid` — every month has at
    // least one week — but the type says it could be, and an empty range is
    // the honest answer rather than a thrown error on a render path.
    const now = new Date();
    return { from: now.toISOString(), to: now.toISOString() };
  }
  const from = startOfDay(firstDay);
  const to = new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

/** The minimum an entry needs for this module to place it on a calendar. */
export interface DatedEntry {
  readonly scheduledAt: string;
}

/**
 * Entries bucketed by the local day they fall on, each bucket in
 * chronological order.
 *
 * An unparseable `scheduledAt` is dropped rather than bucketed under
 * `NaN-NaN-NaN`: it belongs to no square, and a calendar silently omitting
 * one malformed record is better than one rendering a garbage column.
 * `formatDateTime` still shows the raw value anywhere such a record is
 * listed individually, so it is not invisible everywhere at once.
 */
export function groupByDay<T extends DatedEntry>(
  items: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const at = new Date(item.scheduledAt);
    if (Number.isNaN(at.getTime())) {
      continue;
    }
    const key = dayKey(at);
    const bucket = byDay.get(key);
    if (bucket) {
      bucket.push(item);
    } else {
      byDay.set(key, [item]);
    }
  }
  for (const bucket of byDay.values()) {
    // ISO-8601 instants at a fixed offset sort correctly as strings, and
    // every value here comes from the API in `Z` form.
    bucket.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }
  return byDay;
}

/**
 * The day a freshly-opened calendar should describe below the grid: today
 * when today is in view, otherwise the first day of the month that has
 * anything on it, otherwise nothing.
 *
 * "Otherwise nothing" rather than "otherwise the 1st": an empty panel headed
 * with an arbitrary date reads as though that date were meaningful. A month
 * with no appointments says so instead.
 */
export function defaultSelectedDay(
  weeks: readonly (readonly Date[])[],
  month: CalendarMonth,
  byDay: ReadonlyMap<string, readonly DatedEntry[]>,
  now: Date,
): string | undefined {
  const days = weeks.flat();
  const today = days.find((day) => isSameDay(day, now));
  if (today) {
    return dayKey(today);
  }
  const firstBusy = days.find(
    (day) => isInMonth(day, month) && (byDay.get(dayKey(day))?.length ?? 0) > 0,
  );
  return firstBusy ? dayKey(firstBusy) : undefined;
}
