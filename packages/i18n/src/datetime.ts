// 2026-09-03: one rendering of an instant, everywhere in the app.
//
// The owner, comparing a patient's own dashboard against the same
// patient's record on a clinician account: *"the dates are different, the
// timestamp has different format."* The instants were in fact identical —
// `9/3/2026, 9:25:00 PM` and `03/09/2026, 21:25:00` are the same moment.
// Every screen that showed a time called `new Date(iso).toLocaleString()`
// with no locale argument, which formats in **the reader's browser
// locale, not the site's**, so one machine rendered month-first and
// another day-first.
//
// That is not a difference of style. `9/3` and `03/09` disagree about
// whether the appointment is in September or in March, and nothing on the
// screen says which reading applies — on a page whose entire purpose is
// telling someone when to turn up, that is the worst possible ambiguity.
//
// So, three decisions, and each one is the fix for a specific way the old
// call could mislead:
//
//   1. **The site's locale decides, never the browser's.** Two people
//      looking at the same appointment now read the same sentence.
//   2. **The month is spelled, never numbered.** No ordering convention
//      can make "September 3" mean the ninth of March.
//   3. **The zone is named.** A patient and a clinician in different
//      timezones is the ordinary case for a video appointment, not an
//      edge one, and each still sees the time in their own zone — the
//      label is what stops that from looking like a disagreement.
//
// A fourth, added 2026-09-07 and stated because it had until then been an
// accident of the locale rather than a choice:
//
//   4. **The style is "September 3, 2026" — month first, in `en`.** The
//      owner, shown that the site rendered US-style rather than the UK
//      "3 September 2026" a British practice might expect: *"for style, use
//      September 3, 2026 style across."* Bare `en` is what produces it, so
//      nothing here changes — but the next person to notice the mismatch
//      between the practice's country and its dates would reasonably
//      "correct" the locale to `en-GB` and quietly restyle every date on
//      the site. It is a decision. `datetime.test.ts` asserts it, so
//      changing it fails a test named after the reason rather than a
//      snapshot.
//
//      Note rule 2 is what makes this safe either way: the month is spelled
//      in both styles, so the choice between them is taste, never meaning.
//
// `Locale` is imported as a type only, the same shape `format.ts` uses:
// this module is a leaf, and taking a runtime import from `index.js`
// (which re-exports this file) would close a cycle. That is also why
// `locale` is a required parameter rather than one defaulting to
// `defaultLocale` — a caller that has no locale to hand can pass the
// export it already imports from the package root.
import type { Locale } from './index.js';

/**
 * Deliberately explicit components rather than `dateStyle`/`timeStyle`:
 * `Intl.DateTimeFormat` throws a `TypeError` if either style is combined
 * with an individual component option, and `timeZoneName` is an
 * individual one — so naming the zone means naming everything.
 */
const DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

/**
 * An ISO-8601 instant as a sentence — "3 September 2026 at 21:25 GMT+1",
 * in whichever zone the reader is actually in.
 *
 * An unparseable value comes back **as it went in** rather than as
 * "Invalid Date": a raw timestamp on the screen is a fault someone can
 * report and a developer can trace, where "Invalid Date" is neither.
 */
export function formatDateTime(value: string | Date, locale: Locale): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return typeof value === 'string' ? value : '';
  }
  return new Intl.DateTimeFormat(locale, DATE_TIME_OPTIONS).format(instant);
}

// 2026-09-06: the account dashboard's month calendar needs four smaller
// renderings of a date than the whole sentence above — a month heading, a
// column of weekday abbreviations, a day number in each cell, and a start
// time on each appointment chip.
//
// They live here, beside `formatDateTime`, for the reason this file exists
// at all: the moment a screen reaches for `toLocaleDateString()` on its own,
// it starts formatting in the *reader's browser locale* rather than the
// site's, and two people looking at the same calendar stop seeing the same
// month. Rule 1 above is not specific to a full timestamp.
//
// Rule 3 — "the zone is named" — deliberately does **not** carry over. These
// four render *inside* a calendar whose own heading already establishes the
// month, and a zone suffix on all forty-two day numbers would be noise;
// `formatDateTime` remains the one that names it, and the calendar uses that
// one wherever a single appointment is shown in full. Every one of these
// still formats in the reader's own zone, which is what makes the grid agree
// with the times printed on it.

/** Deliberately not `Number.prototype.toString()`: a locale with its own digits should get them. */
const DAY_OF_MONTH_OPTIONS: Intl.DateTimeFormatOptions = { day: 'numeric' };
const MONTH_YEAR_OPTIONS: Intl.DateTimeFormatOptions = { month: 'long', year: 'numeric' };
const WEEKDAY_SHORT_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'short' };
const WEEKDAY_LONG_OPTIONS: Intl.DateTimeFormatOptions = { weekday: 'long' };
/** No `timeZoneName`: see the note above on why rule 3 stops at this file's own boundary. */
const TIME_OF_DAY_OPTIONS: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
/** No weekday: a *range* names two ends, and two weekdays in one label is noise. */
const MONTH_DAY_YEAR_OPTIONS: Intl.DateTimeFormatOptions = {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
};
/** A day named in full, for the panel that lists one day's appointments. */
const DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
};

function format(
  value: string | Date,
  locale: Locale,
  options: Intl.DateTimeFormatOptions,
): string {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) {
    // Same choice `formatDateTime` documents: the raw value is a fault
    // someone can report, where "Invalid Date" is not.
    return typeof value === 'string' ? value : '';
  }
  return new Intl.DateTimeFormat(locale, options).format(instant);
}

/** "September 2026" — a calendar's own heading. */
export function formatMonthYear(value: string | Date, locale: Locale): string {
  return format(value, locale, MONTH_YEAR_OPTIONS);
}

/** "Mon" — a calendar's column headers. */
export function formatWeekdayShort(value: string | Date, locale: Locale): string {
  return format(value, locale, WEEKDAY_SHORT_OPTIONS);
}

/** "Monday" — the accessible name behind an abbreviated column header. */
export function formatWeekdayLong(value: string | Date, locale: Locale): string {
  return format(value, locale, WEEKDAY_LONG_OPTIONS);
}

/** "3" — a day number in a calendar cell. */
export function formatDayOfMonth(value: string | Date, locale: Locale): string {
  return format(value, locale, DAY_OF_MONTH_OPTIONS);
}

/** "21:25" — an appointment chip, where the day is already established by the cell it sits in. */
export function formatTimeOfDay(value: string | Date, locale: Locale): string {
  return format(value, locale, TIME_OF_DAY_OPTIONS);
}

/** "Thursday, 3 September 2026" — the heading of a selected day's list. */
export function formatDate(value: string | Date, locale: Locale): string {
  return format(value, locale, DATE_OPTIONS);
}

/**
 * "3 September 2026" — a date on its own, with no weekday.
 *
 * 2026-09-07, for the publication date on a blog post and a workshop. The
 * weekday `formatDate` carries is what someone needs to *plan around* a
 * day; on a byline it is noise, and "Thursday, 3 September 2026" under a
 * headline reads as the date of an event rather than of the writing.
 *
 * Shares `MONTH_DAY_YEAR_OPTIONS` with `formatDateRange` below, which is
 * already the "a date, without the weekday" shape.
 */
export function formatDayMonthYear(value: string | Date, locale: Locale): string {
  return format(value, locale, MONTH_DAY_YEAR_OPTIONS);
}

/** "1 Sep" — the marker the calendar puts on the first day of a month, where the grid spans two. */
export function formatDayMonthShort(value: string | Date, locale: Locale): string {
  return format(value, locale, { day: 'numeric', month: 'short' });
}

/**
 * "17 August – 20 September 2026" — the span a rolling calendar window
 * covers.
 *
 * `Intl.DateTimeFormat.prototype.formatRange` rather than two `formatDate`
 * calls joined by a dash, because the correct rendering of a range is not
 * concatenation: it collapses the parts the two ends share, and *which*
 * parts those are is locale-specific ("17–20 September 2026" within one
 * month, "August 17 – September 20, 2026" across two). Gluing two full dates
 * together would produce a correct-but-clumsy string in English and a wrong
 * one somewhere else.
 *
 * Falls back to the join when `formatRange` is unavailable — it is ES2021
 * and present in every browser this site supports, but a formatter that
 * throws on a range would take the whole calendar down with it, and a
 * clumsier label is not worth that.
 */
export function formatDateRange(from: string | Date, to: string | Date, locale: Locale): string {
  const start = from instanceof Date ? from : new Date(from);
  const end = to instanceof Date ? to : new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return `${formatDate(from, locale)} – ${formatDate(to, locale)}`;
  }
  const formatter = new Intl.DateTimeFormat(locale, MONTH_DAY_YEAR_OPTIONS);
  try {
    return formatter.formatRange(start, end);
  } catch {
    return `${formatDate(from, locale)} – ${formatDate(to, locale)}`;
  }
}
