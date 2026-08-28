// TASK 5.5.3 step 1. Deliberately does not render the component — this
// directory has no jsdom/RTL pattern (join-window.test.ts's own
// precedent, followed again by NextAppointmentPanel.test.ts) — so the
// pure functions the join link and the fetch window depend on are tested
// directly instead.
import { describe, expect, it } from 'vitest';

import { CALENDAR_WINDOW_DAYS, calendarWindow, callHref } from './ClinicianCalendar.js';
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
  it('spans from now to CALENDAR_WINDOW_DAYS ahead', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    expect(calendarWindow(now)).toEqual({
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-10-01T00:00:00.000Z',
    });
  });

  it('mirrors CALENDAR_WINDOW_DAYS, not a magic number', () => {
    expect(CALENDAR_WINDOW_DAYS).toBe(30);
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
