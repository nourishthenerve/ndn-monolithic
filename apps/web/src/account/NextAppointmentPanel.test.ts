// TASK 5.5.3 step 1: closes video-calls.md's own "no reachable link to
// this page from anywhere else in the account shell" gap, on the patient
// side. Deliberately does not render the component — this directory has
// no jsdom/RTL pattern (join-window.test.ts's own precedent) — so the two
// pure functions the join link depends on are tested directly instead.
import { describe, expect, it } from 'vitest';

import { callHref, findNext } from './NextAppointmentPanel.js';
import type { AppointmentEntry } from './NextAppointmentPanel.js';

function entry(overrides: Partial<AppointmentEntry> = {}): AppointmentEntry {
  return {
    patientId: 'pat-1',
    scheduledAt: '2026-09-01T10:00:00.000Z',
    durationMinutes: 30,
    appointment_status: 'scheduled',
    ...overrides,
  };
}

const at = (iso: string) => new Date(iso);

describe('findNext', () => {
  it('picks the first scheduled item that has not finished', () => {
    const items = [
      entry({ scheduledAt: '2026-08-01T10:00:00.000Z', appointment_status: 'completed' }),
      entry({ scheduledAt: '2026-09-01T10:00:00.000Z' }),
      entry({ scheduledAt: '2026-09-05T10:00:00.000Z' }),
    ];
    expect(findNext(items, at('2026-08-30T00:00:00.000Z'))).toEqual(items[1]);
  });

  it('skips a cancelled appointment even if it is next chronologically', () => {
    const items = [
      entry({ scheduledAt: '2026-09-01T10:00:00.000Z', appointment_status: 'cancelled' }),
      entry({ scheduledAt: '2026-09-05T10:00:00.000Z' }),
    ];
    expect(findNext(items, at('2026-08-30T00:00:00.000Z'))).toEqual(items[1]);
  });

  it('is undefined when nothing scheduled remains', () => {
    const items = [entry({ scheduledAt: '2026-01-01T10:00:00.000Z' })];
    expect(findNext(items, at('2026-08-30T00:00:00.000Z'))).toBeUndefined();
  });

  it('is undefined for an empty list', () => {
    expect(findNext([], at('2026-08-30T00:00:00.000Z'))).toBeUndefined();
  });
});

// 2026-09-03. The reported bug, at the exact instant it used to happen.
// The owner: *"when the item of appointment arrived the 'join the call'
// button simply didnt appear … the dashboard simply started showing the
// next appointment item."* This picked the next appointment by
// `scheduledAt >= now`, which stops being true at the same instant the
// join window opens — so the appointment vanished from the panel exactly
// when its button was due to appear.
describe('the appointment happening right now', () => {
  const items = [
    entry({ scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 }),
    entry({ scheduledAt: '2026-09-05T10:00:00.000Z' }),
  ];

  it.each([
    ['at the very start', '2026-09-01T10:00:00.000Z'],
    ['a second in', '2026-09-01T10:00:01.000Z'],
    ['halfway through', '2026-09-01T10:15:00.000Z'],
    ['one millisecond before the end', '2026-09-01T10:29:59.999Z'],
  ])('is still the next appointment %s', (_label, now) => {
    expect(findNext(items, at(now))).toEqual(items[0]);
  });

  it('hands over to the following appointment the instant the slot ends', () => {
    expect(findNext(items, at('2026-09-01T10:30:00.000Z'))).toEqual(items[1]);
  });

  it('respects the booked length, not a fixed one', () => {
    const long = [entry({ scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 90 })];
    expect(findNext(long, at('2026-09-01T11:00:00.000Z'))).toEqual(long[0]);
    expect(findNext(long, at('2026-09-01T11:30:00.000Z'))).toBeUndefined();
  });

  it('never offers a row whose time cannot be read', () => {
    // `NaN` comparisons are all false, so a malformed row would otherwise
    // fall through as though it were live and present a link the server
    // is certain to refuse.
    expect(findNext([entry({ scheduledAt: 'not-a-date' })], at('2026-09-01T10:00:00.000Z'))).toBeUndefined();
  });
});

describe('callHref', () => {
  it('builds a locale-prefixed link to the call page', () => {
    expect(callHref('en', entry())).toBe(
      '/en/account/call?appointmentId=pat-1%232026-09-01T10%3A00%3A00.000Z',
    );
  });

  it('percent-encodes the "#" separator so the query string is not truncated at a fragment', () => {
    const href = callHref('en', entry());
    // A literal, un-encoded "#" here would make everything after it a URL
    // fragment instead of part of the query string — the one failure mode
    // this test exists to catch.
    expect(href.indexOf('#')).toBe(-1);
    expect(new URL(href, 'https://example.com').searchParams.get('appointmentId')).toBe(
      'pat-1#2026-09-01T10:00:00.000Z',
    );
  });
});
