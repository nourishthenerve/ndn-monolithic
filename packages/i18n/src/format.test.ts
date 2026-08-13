import { describe, expect, it } from 'vitest';

import { formatMessage } from './format.js';

describe('formatMessage', () => {
  it('interpolates a plain variable', () => {
    expect(formatMessage('Hello, {name}!', { name: 'Ada' }, 'en')).toBe('Hello, Ada!');
  });

  it('round-trips ICU plural formatting', () => {
    const template = 'You have {count, plural, one {# item} other {# items}}.';
    expect(formatMessage(template, { count: 1 }, 'en')).toBe('You have 1 item.');
    expect(formatMessage(template, { count: 5 }, 'en')).toBe('You have 5 items.');
  });

  it('round-trips ICU date formatting', () => {
    const template = 'Booked for {when, date, medium}.';
    // A fixed instant, not `Date.now()` (00-conventions.md: "time is
    // injectable — no test reads the wall clock").
    const when = Date.UTC(2026, 0, 15);
    const expected = new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(when);
    expect(formatMessage(template, { when }, 'en')).toBe(`Booked for ${expected}.`);
  });

  it('round-trips ICU number formatting', () => {
    const template = 'Total: {amount, number, ::currency/GBP}';
    const expected = new Intl.NumberFormat('en', { style: 'currency', currency: 'GBP' }).format(
      12.5,
    );
    expect(formatMessage(template, { amount: 12.5 }, 'en')).toBe(`Total: ${expected}`);
  });

  it('never throws on a template with no vars needed', () => {
    expect(formatMessage('Plain text, no placeholders.', undefined, 'en')).toBe(
      'Plain text, no placeholders.',
    );
  });
});
