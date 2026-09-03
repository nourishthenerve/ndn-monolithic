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

import { formatDateTime } from './datetime.js';

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
