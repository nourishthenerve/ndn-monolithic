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

describe('findNext', () => {
  it('picks the first scheduled item not yet in the past', () => {
    const items = [
      entry({ scheduledAt: '2026-08-01T10:00:00.000Z', appointment_status: 'completed' }),
      entry({ scheduledAt: '2026-09-01T10:00:00.000Z' }),
      entry({ scheduledAt: '2026-09-05T10:00:00.000Z' }),
    ];
    expect(findNext(items, '2026-08-30T00:00:00.000Z')).toEqual(items[1]);
  });

  it('skips a cancelled appointment even if it is next chronologically', () => {
    const items = [
      entry({ scheduledAt: '2026-09-01T10:00:00.000Z', appointment_status: 'cancelled' }),
      entry({ scheduledAt: '2026-09-05T10:00:00.000Z' }),
    ];
    expect(findNext(items, '2026-08-30T00:00:00.000Z')).toEqual(items[1]);
  });

  it('is undefined when nothing scheduled remains in the future', () => {
    const items = [entry({ scheduledAt: '2026-01-01T10:00:00.000Z' })];
    expect(findNext(items, '2026-08-30T00:00:00.000Z')).toBeUndefined();
  });

  it('is undefined for an empty list', () => {
    expect(findNext([], '2026-08-30T00:00:00.000Z')).toBeUndefined();
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
