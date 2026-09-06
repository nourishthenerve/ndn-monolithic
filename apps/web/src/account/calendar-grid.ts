// 2026-09-06: the date arithmetic behind the dashboard's calendar.
//
// The owner: *"in calender view place todays date in the middle so that I
// see a 2 weeks backward and 2 weeks forward."*
//
// **This replaces a calendar-month grid, and the change is the point.** A
// month grid cannot put today in the middle — on the 2nd, today is in the
// top row; on the 30th, the bottom. What is wanted is a *rolling window*
// anchored on today: two weeks of context behind, two ahead, with today's
// week in the middle row. So the unit this module works in is a window of
// whole weeks, not a named month.
//
// Whole weeks, not exactly ±14 days: the columns have to keep lining up
// under Mon…Sun headers, which is most of what makes a grid read as a
// calendar rather than a table of dates. A 29-day exact window would put a
// different weekday at the start of each row. The cost is that the window
// reaches a little past two weeks in one direction and a little short in the
// other, depending on which weekday today is — 35 days either way.
//
// Every function here is pure and takes its own clock, so the grid, the
// fetch range and the grouping can be tested without a DOM, a timer or a
// network.
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

/** Weeks of history the default view opens on — the owner's "2 weeks backward". */
export const WEEKS_BEFORE = 2;
/** Weeks ahead the default view opens on — "2 weeks forward". */
export const WEEKS_AFTER = 2;

/** Rows in the grid: two behind, today's own, two ahead. */
export const WINDOW_WEEKS = WEEKS_BEFORE + 1 + WEEKS_AFTER;

/**
 * How far one press of the back/forward control moves the window.
 *
 * Two weeks, not five: the window is the unit the owner described, and
 * paging by its full width would swap the whole view for an unrelated one.
 * Moving by half of it keeps three weeks of what was on screen still on
 * screen, so a run of appointments is followed rather than jumped over. The
 * cost is more presses to reach distant history, which is what the "Today"
 * control exists to undo in one.
 */
export const WINDOW_STEP_WEEKS = 2;

/** The first instant of a local calendar day. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The start of the local week `date` falls in, per `WEEK_STARTS_ON`. */
export function startOfWeek(date: Date): Date {
  const offset = (date.getDay() - WEEK_STARTS_ON + DAYS_IN_WEEK) % DAYS_IN_WEEK;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset);
}

/**
 * Where the window sits when it is centred on `date` — the start of the week
 * `WEEKS_BEFORE` weeks before `date`'s own week.
 *
 * This is what "today in the middle" means concretely: `date`'s week becomes
 * the middle row of `WINDOW_WEEKS`.
 */
export function windowStartFor(date: Date): Date {
  const week = startOfWeek(date);
  return new Date(
    week.getFullYear(),
    week.getMonth(),
    week.getDate() - WEEKS_BEFORE * DAYS_IN_WEEK,
  );
}

/** The window `weeks` weeks away — this is what "scroll left and right" is. */
export function shiftWindow(windowStart: Date, weeks: number): Date {
  // No wrap arithmetic: `Date` normalises a day number past the end of its
  // month itself, which is what makes crossing a month or year boundary a
  // non-event here.
  return new Date(
    windowStart.getFullYear(),
    windowStart.getMonth(),
    windowStart.getDate() + weeks * DAYS_IN_WEEK,
  );
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

/** Whether `day` is a calendar day already past on `now`'s clock. */
export function isPastDay(day: Date, now: Date): boolean {
  return startOfDay(day).getTime() < startOfDay(now).getTime();
}

/**
 * The window as rows of seven, starting at `windowStart`.
 *
 * Every row begins on `WEEK_STARTS_ON` by construction, because
 * `windowStart` is itself a week start and each row is seven days on from
 * the last.
 */
export function windowGrid(windowStart: Date): readonly (readonly Date[])[] {
  return Array.from({ length: WINDOW_WEEKS }, (_unusedWeek, week) =>
    Array.from(
      { length: DAYS_IN_WEEK },
      (_unusedDay, day) =>
        new Date(
          windowStart.getFullYear(),
          windowStart.getMonth(),
          windowStart.getDate() + week * DAYS_IN_WEEK + day,
        ),
    ),
  );
}

/**
 * The UTC instants spanning everything a grid can show, for the ranged
 * `GET /clinicians/me/calendar?from=&to=`.
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
    // Not reachable from `windowGrid`, which always builds `WINDOW_WEEKS`
    // rows — but the type says it could be, and an empty range is the honest
    // answer rather than a thrown error on a render path.
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
 * The day a freshly-drawn window should describe below the grid: today when
 * today is on it, otherwise the first day of the window that has anything on
 * it, otherwise nothing.
 *
 * "Otherwise nothing" rather than "otherwise the first square": an empty
 * panel headed with an arbitrary date reads as though that date were
 * meaningful. A window with no appointments says so instead.
 */
export function defaultSelectedDay(
  weeks: readonly (readonly Date[])[],
  byDay: ReadonlyMap<string, readonly DatedEntry[]>,
  now: Date,
): string | undefined {
  const days = weeks.flat();
  const today = days.find((day) => isSameDay(day, now));
  if (today) {
    return dayKey(today);
  }
  const firstBusy = days.find((day) => (byDay.get(dayKey(day))?.length ?? 0) > 0);
  return firstBusy ? dayKey(firstBusy) : undefined;
}
