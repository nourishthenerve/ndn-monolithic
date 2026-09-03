// TASK 5.5.3 step 1. Deliberately does not render the component — this
// directory has no jsdom/RTL pattern (join-window.test.ts's own
// precedent, followed again by NextAppointmentPanel.test.ts) — so the
// pure functions the join link and the fetch window depend on are tested
// directly instead.
import { describe, expect, it } from 'vitest';

import {
  CALENDAR_LOOKBACK_HOURS,
  CALENDAR_WINDOW_DAYS,
  calendarWindow,
  callHref,
} from './ClinicianCalendar.js';
import type { CalendarEntry } from './ClinicianCalendar.js';

function entry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    patientId: 'pat-1',
    scheduledAt: '2026-09-01T10:00:00.000Z',
    durationMinutes: 30,
    appointment_status: 'scheduled',
    ...overrides,
  };
}

describe('calendarWindow', () => {
  it('spans from CALENDAR_LOOKBACK_HOURS behind to CALENDAR_WINDOW_DAYS ahead', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    expect(calendarWindow(now)).toEqual({
      from: '2026-08-31T12:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
  });

  it('mirrors its own constants, not magic numbers', () => {
    expect(CALENDAR_WINDOW_DAYS).toBe(30);
    expect(CALENDAR_LOOKBACK_HOURS).toBe(12);
  });

  // 2026-09-03, the clinician half of the reported bug. `from` was `now`,
  // and the API turns it into a GSI1 range query keyed on `scheduledAt` —
  // so an appointment left the calendar at the instant it started, which
  // is the instant its join link becomes valid. A range query cannot ask
  // "still running", so the window has to open early enough to catch the
  // *start* of anything that could still be under way.
  it('still includes an appointment that started before now and is still running', () => {
    const now = new Date('2026-09-01T10:15:00.000Z');
    const startedAt = '2026-09-01T10:00:00.000Z';
    const { from, to } = calendarWindow(now);
    expect(from <= startedAt).toBe(true);
    expect(startedAt <= to).toBe(true);
  });

  it('reaches back further than any plausible appointment length', () => {
    // The bug returns for long appointments alone if this shrinks below
    // the longest bookable slot, and nothing bounds `durationMinutes`
    // server-side — so the lookback is deliberately generous.
    expect(CALENDAR_LOOKBACK_HOURS * 60).toBeGreaterThan(4 * 60);
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
    expect(href.indexOf('#')).toBe(-1);
    expect(new URL(href, 'https://example.com').searchParams.get('appointmentId')).toBe(
      'pat-1#2026-09-01T10:00:00.000Z',
    );
  });

  it('differs per patient for the same clinician calendar', () => {
    const a = callHref('en', entry({ patientId: 'pat-1' }));
    const b = callHref('en', entry({ patientId: 'pat-2' }));
    expect(a).not.toBe(b);
  });
});
