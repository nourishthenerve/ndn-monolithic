// 2026-09-03. The bug this guards against is not "the format is ugly" —
// it is that `9/3/2026` and `03/09/2026` were the same appointment, shown
// on two screens of the same app, and a reader had no way to tell that
// they were. See datetime.ts's own header.
//
// The assertions are deliberately about *properties* rather than one
// golden string: the exact output depends on the host's ICU data and its
// timezone, and pinning it would make this suite fail on a machine that is
// not the author's while proving nothing extra.
import { describe, expect, it } from 'vitest';

import {
  formatDate,
  formatDateTimeInZone,
  formatDateRange,
  formatDateTime,
  formatDayMonthShort,
  formatDayMonthYear,
  formatDayOfMonth,
  formatMonthYear,
  formatTimeOfDay,
  formatWeekdayLong,
  formatWeekdayShort,
} from './datetime.js';

const INSTANT = '2026-09-03T20:25:00.000Z';

describe('formatDateTime', () => {
  it('spells the month, so no reading of it can be ambiguous', () => {
    const formatted = formatDateTime(INSTANT, 'en');
    expect(formatted).toContain('September');
    // The whole regression: a numeric month is what let one screen say
    // "9/3" and another "03/09" about the same day.
    expect(formatted).not.toMatch(/\d+\/\d+/);
  });

  it('names the timezone — a patient and a clinician need not be in the same one', () => {
    // Whatever zone the host is in, the label for it is present. Asserting
    // the label itself would only assert the machine running the test.
    const zone = new Intl.DateTimeFormat('en', { timeZoneName: 'short' })
      .formatToParts(new Date(INSTANT))
      .find((part) => part.type === 'timeZoneName')?.value;
    expect(zone).toBeDefined();
    expect(formatDateTime(INSTANT, 'en')).toContain(zone as string);
  });

  it('reads a Date and its own ISO string identically', () => {
    expect(formatDateTime(new Date(INSTANT), 'en')).toBe(formatDateTime(INSTANT, 'en'));
  });

  it('formats from the locale it is given, never the host default', () => {
    // `toLocaleString()` with no argument is the call this function
    // replaces. It is free to differ from this one — that it *can* is the
    // reason the app no longer uses it — so this only pins that our own
    // output tracks the requested locale.
    expect(formatDateTime(INSTANT, 'en')).toBe(
      new Intl.DateTimeFormat('en', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short',
      }).format(new Date(INSTANT)),
    );
  });

  it('hands back an unparseable value unchanged rather than "Invalid Date"', () => {
    // A raw value on screen is a fault someone can report and a developer
    // can trace to the row that holds it. "Invalid Date" is neither.
    expect(formatDateTime('not-a-date', 'en')).toBe('not-a-date');
    expect(formatDateTime(new Date(Number.NaN), 'en')).toBe('');
  });
});

// 2026-09-06: the four smaller renderings the dashboard's month calendar
// needs. What is worth asserting is not the exact English wording — that is
// `Intl`'s to decide and varies by ICU version — but the three properties
// this module exists to guarantee: the site's locale decides, the month is
// never a bare number, and an unparseable value survives visibly.
describe('the calendar formatters', () => {
  const AT = new Date(2026, 8, 15, 14, 30);

  it('spell the month rather than numbering it, in the month heading and the full date', () => {
    expect(formatMonthYear(AT, 'en')).toContain('September');
    expect(formatMonthYear(AT, 'en')).toContain('2026');
    expect(formatDate(AT, 'en')).toContain('September');
    // No ordering convention can make a spelled month mean a different one —
    // the whole point of rule 2 in this module's header.
    expect(formatMonthYear(AT, 'en')).not.toMatch(/\b9\b/);
  });

  it('name the weekday both short and long, so an abbreviation always has a full form behind it', () => {
    expect(formatWeekdayLong(AT, 'en')).toBe('Tuesday');
    expect(formatWeekdayShort(AT, 'en')).toBe('Tue');
  });

  it('render a bare day number and a bare time, since the cell around them carries the rest', () => {
    expect(formatDayOfMonth(AT, 'en')).toBe('15');
    // No timezone suffix here: forty-two of them on one grid is noise, and
    // `formatDateTime` still names the zone wherever a single appointment is
    // shown in full. See this module's own note on rule 3.
    expect(formatTimeOfDay(AT, 'en')).not.toMatch(/GMT|UTC/);
    expect(formatTimeOfDay(AT, 'en')).toContain('30');
  });

  it('track the requested locale rather than the machine default', () => {
    expect(formatMonthYear(AT, 'en')).toBe(
      new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' }).format(AT),
    );
  });

  it('hand back an unparseable value unchanged, exactly as formatDateTime does', () => {
    expect(formatMonthYear('not-a-date', 'en')).toBe('not-a-date');
    expect(formatDate('not-a-date', 'en')).toBe('not-a-date');
    expect(formatDayOfMonth(new Date(Number.NaN), 'en')).toBe('');
    expect(formatTimeOfDay('nope', 'en')).toBe('nope');
    expect(formatWeekdayShort('nope', 'en')).toBe('nope');
    expect(formatWeekdayLong('nope', 'en')).toBe('nope');
  });
});

// 2026-09-06: the calendar became a rolling window spanning two months, so
// its heading is a range rather than a month name.
describe('formatDateRange', () => {
  it('collapses what the two ends share, rather than printing two full dates', () => {
    // Within one month the month and year are said once — which is the whole
    // reason this is `formatRange` and not two `formatDate`s and a dash.
    const within = formatDateRange(new Date(2026, 8, 17), new Date(2026, 8, 20), 'en');
    expect(within).toContain('September');
    expect(within.match(/September/g)).toHaveLength(1);
    expect(within.match(/2026/g)).toHaveLength(1);
  });

  it('names both months when the range crosses one', () => {
    const across = formatDateRange(new Date(2026, 7, 31), new Date(2026, 9, 4), 'en');
    expect(across).toContain('August');
    expect(across).toContain('October');
  });

  it('names both years when the range crosses one', () => {
    const across = formatDateRange(new Date(2026, 11, 28), new Date(2027, 0, 31), 'en');
    expect(across).toContain('2026');
    expect(across).toContain('2027');
  });

  it('falls back to a plain join rather than throwing on an unparseable end', () => {
    // A formatter that threw would take the whole calendar down with it.
    expect(() => formatDateRange('nope', new Date(2026, 8, 20), 'en')).not.toThrow();
    expect(formatDateRange('nope', 'also-nope', 'en')).toContain('nope');
  });
});

describe('formatDayMonthShort', () => {
  it('names the month beside the day, for the square where a month turns over', () => {
    const label = formatDayMonthShort(new Date(2026, 8, 1), 'en');
    expect(label).toContain('1');
    expect(label).toMatch(/Sep/);
  });
});

// 2026-09-07: the byline date on a blog post and a workshop announcement.
describe('formatDayMonthYear', () => {
  it('spells the month and drops the weekday', () => {
    const label = formatDayMonthYear('2026-09-03T09:00:00.000Z', 'en');

    expect(label).toContain('September');
    expect(label).toContain('2026');
    // The distinction from `formatDate`: a byline is not a diary entry, and
    // "Thursday" above a headline reads as the date of an event.
    expect(label).not.toMatch(/Thursday/);
  });

  it('returns an unparseable value unchanged rather than "Invalid Date"', () => {
    expect(formatDayMonthYear('not-a-date', 'en')).toBe('not-a-date');
  });
});

// 2026-09-07, rule 4 in this module's own header: *"for style, use September
// 3, 2026 style across."* One test over every formatter that renders a
// month, so switching the catalogue to `en-GB` — a reasonable-looking
// "correction" for a UK practice — fails here rather than silently
// restyling every date on the site.
describe('the house date style', () => {
  const instant = '2026-09-03T09:00:00.000Z';

  it.each([
    ['formatDayMonthYear', formatDayMonthYear(instant, 'en')],
    ['formatDateTime', formatDateTime(instant, 'en')],
    ['formatDate', formatDate(instant, 'en')],
  ])('%s puts the month before the day', (_name, rendered) => {
    expect(rendered).toContain('September 3, 2026');
  });

  it('never renders a bare numeric date, whatever the style', () => {
    // Rule 2, which is the one that carries meaning rather than taste:
    // "9/3" and "03/09" disagree about the month.
    expect(formatDayMonthYear(instant, 'en')).not.toMatch(/\d+\/\d+/);
  });
});

// 2026-09-07: a workshop announced to three regions at once — the one place
// the site renders a time in a named zone rather than the reader's own.
describe('formatDateTimeInZone', () => {
  const tenUtc = '2026-10-01T10:00:00.000Z';

  it('renders the same instant as each region reads it', () => {
    expect(formatDateTimeInZone(tenUtc, 'en', 'Asia/Kolkata')).toContain('3:30 PM');
    expect(formatDateTimeInZone(tenUtc, 'en', 'Europe/London')).toContain('11:00 AM');
    expect(formatDateTimeInZone(tenUtc, 'en', 'Asia/Dubai')).toContain('2:00 PM');
  });

  it('is the same wherever the machine rendering it happens to be', () => {
    // The whole point of naming the zone: unlike `formatDateTime`, this
    // does not move with the host, so a page built in CI and the same page
    // reconciled in a reader's browser agree.
    expect(formatDateTimeInZone(tenUtc, 'en', 'Europe/London')).toBe(
      formatDateTimeInZone(new Date(tenUtc), 'en', 'Europe/London'),
    );
  });

  it('carries each zone’s own date, not a shared one', () => {
    // A 9:00 PM UK workshop is the next morning in India.
    const lateUtc = '2026-10-01T20:00:00.000Z';

    expect(formatDateTimeInZone(lateUtc, 'en', 'Asia/Kolkata')).toContain('October 2, 2026');
    expect(formatDateTimeInZone(lateUtc, 'en', 'Europe/London')).toContain('October 1, 2026');
  });

  it('names the offset, because a region label is not a zone', () => {
    // "Middle East" is GMT+4 in Dubai and GMT+3 in Riyadh.
    expect(formatDateTimeInZone(tenUtc, 'en', 'Asia/Dubai')).toMatch(/GMT\+4/);
  });

  it('returns an unparseable value unchanged rather than "Invalid Date"', () => {
    expect(formatDateTimeInZone('not-a-date', 'en', 'Europe/London')).toBe('not-a-date');
  });
});
