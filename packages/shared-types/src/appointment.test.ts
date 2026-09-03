// 2026-09-03: the one server-side answer to "when is this appointment
// over", extracted because four surfaces had each answered it separately
// and all four had answered it the same way wrong — treating a start that
// has passed as an appointment that has finished. See
// `isAppointmentOver`'s own note for what that cost.
import { describe, expect, it } from 'vitest';

import { appointmentEndsAt, isAppointmentOver } from './appointment.js';

const SCHEDULED_AT = '2026-09-10T14:00:00.000Z';
const DURATION = 45;

const at = (iso: string) => new Date(iso);

describe('appointmentEndsAt', () => {
  it('is the start plus the booked duration', () => {
    expect(new Date(appointmentEndsAt(SCHEDULED_AT, DURATION)).toISOString()).toBe(
      '2026-09-10T14:45:00.000Z',
    );
  });

  it('gives a longer appointment a later end — the length is the appointment, not a fixed grace', () => {
    expect(appointmentEndsAt(SCHEDULED_AT, 90)).toBeGreaterThan(
      appointmentEndsAt(SCHEDULED_AT, 15),
    );
  });
});

describe('isAppointmentOver', () => {
  it.each([
    ['a day before', '2026-09-09T14:00:00.000Z', false],
    ['one millisecond before the start', '2026-09-10T13:59:59.999Z', false],
    // The instant the whole bug turned on: the appointment is not over
    // here, it is *happening*, and this is when its join window opens.
    ['exactly at the start', '2026-09-10T14:00:00.000Z', false],
    ['midway through', '2026-09-10T14:22:00.000Z', false],
    ['one millisecond before the end', '2026-09-10T14:44:59.999Z', false],
    // `>=` on the end, matching `ws-join.ts`: the last millisecond of a
    // booked slot is past the end of it.
    ['exactly at the end', '2026-09-10T14:45:00.000Z', true],
    ['an hour after', '2026-09-10T15:00:00.000Z', true],
  ])('is %s → %s', (_label, now, expected) => {
    expect(isAppointmentOver(SCHEDULED_AT, DURATION, at(now))).toBe(expected);
  });

  it('calls an unreadable time over, never live', () => {
    // Deny by default, the reading every other parse of `scheduledAt`
    // takes: a row nobody can place in time must not present a join link.
    expect(isAppointmentOver('not-a-date', DURATION, at(SCHEDULED_AT))).toBe(true);
  });
});
