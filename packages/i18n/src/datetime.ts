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
