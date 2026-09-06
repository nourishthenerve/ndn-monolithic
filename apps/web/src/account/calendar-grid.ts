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
// ## 2026-09-06, second pass: the columns anchor on *today*, not on Monday
//
// The owner, on seeing the first version: *"the calender I'm seeing still is
// not aligned in the middle. I want current date to be in the middle so that
// I see 2 weeks backward and 2 weeks forward."*
//
// The first version centred today's **week** and left the columns pinned to
// Monday. That is not the same thing, and on most days it does not look like
// it either: with fixed Mon…Sun columns, today's position in the grid is
// decided entirely by today's weekday and cannot be moved. Sunday 6 September
// 2026 — the day the complaint was made — put today in the *last* column of
// the middle row, with 20 days of history behind it and only 14 ahead.
//
// So the trade is forced, and worth naming rather than burying. A five-by-
// seven grid has exactly one middle square, and a day can only sit in it if
// the columns are allowed to start on that day's own weekday. Keeping Monday
// in column one means giving up centring on six days out of seven; centring
// means giving up a fixed Monday. The owner has now asked for centring twice,
// so Monday is what gives.
//
// What that buys: today is always the middle square — `CENTER_ROW` /
// `CENTER_COLUMN` — with **17 days either side, symmetrically**, which covers
// the fortnight each way that was asked for and never leans one way. What it
// costs: the weekday headers rotate as the days pass, so this reads as a
// rolling window labelled with weekdays rather than as a wall calendar. Every
// column still carries its own weekday name (`AppointmentCalendar` renders
// the headers from row one), so nothing is ambiguous — only unfamiliar.
//
// `shiftWindow` still moves in whole weeks, which is what keeps the columns
// stable while paging: the headers only change when "Today" re-centres.
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

export const DAYS_IN_WEEK = 7;

/** Weeks of history the default view opens on — the owner's "2 weeks backward". */
export const WEEKS_BEFORE = 2;
/** Weeks ahead the default view opens on — "2 weeks forward". */
export const WEEKS_AFTER = 2;

/** Rows in the grid: two behind, today's own, two ahead. */
export const WINDOW_WEEKS = WEEKS_BEFORE + 1 + WEEKS_AFTER;

/**
 * Where today sits in the grid — the middle square of `WINDOW_WEEKS` rows of
 * `DAYS_IN_WEEK`.
 *
 * `CENTER_ROW` is `WEEKS_BEFORE` by construction (two rows above it, two
 * below). `CENTER_COLUMN` is the middle of an odd-width row, which is the
 * only reason the grid is seven wide rather than six or eight: an even width
 * has no middle column and could not centre anything.
 */
export const CENTER_ROW = WEEKS_BEFORE;
export const CENTER_COLUMN = (DAYS_IN_WEEK - 1) / 2;

/**
 * How far back the window starts from the day it is centred on: 17 days, so
 * that day lands on `CENTER_ROW`/`CENTER_COLUMN` with the same 17 ahead.
 */
export const CENTER_OFFSET_DAYS = CENTER_ROW * DAYS_IN_WEEK + CENTER_COLUMN;

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

/**
 * Where the window starts when it is centred on `date` — `CENTER_OFFSET_DAYS`
 * before it, so `date` itself lands on the middle square.
 *
 * This is what "today in the middle" means concretely, and it is deliberately
 * *not* week-aligned: aligning to Monday is precisely what stopped the first
 * version from centring anything (see this module's header). The window's
 * first day is whatever weekday sits 17 days before `date`, and every row
 * starts on that weekday because `windowGrid` counts in sevens from it.
 */
export function windowStartFor(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() - CENTER_OFFSET_DAYS,
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
 * Every row begins on the *same weekday* by construction — whichever weekday
 * `windowStart` is — because each row is seven days on from the last. That is
 * what keeps the columns lining up under their headers; which weekday heads
 * column one is `windowStartFor`'s business, not this function's.
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
