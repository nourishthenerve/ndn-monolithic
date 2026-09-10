// @vitest-environment jsdom
//
// 2026-09-10: the clinician's next-appointment lead. `findNext` and the
// three-zone/countdown rendering are tested where they live; what this pins
// is the plumbing this component adds — that it reads the clinician's own
// calendar, picks the earliest upcoming scheduled appointment out of it, and
// hands it to the same view the patient's panel uses, rendering nothing when
// there is no calendar to read.
import { defaultLocale, formatDateTimeInZone } from '@ndn/i18n';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ClinicianNextAppointment } from './ClinicianNextAppointment.js';

afterEach(cleanup);

const STRINGS = {
  appointmentLabel: 'Next appointment',
  durationLabel: 'Next appointment length (minutes)',
  emptyLabel: 'No appointment is booked yet.',
};

const client = (token: string | undefined) =>
  ({ authorization: () => Promise.resolve(token) }) as never;

/** A fixed clock, stable across renders — the shape `useNow` requires. */
const at = (iso: string) => {
  const frozen = new Date(iso);
  return () => frozen;
};

const ok = (items: unknown[]): Promise<Response> =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items }) } as Response);

const NOW = '2026-09-18T06:00:00.000Z';

describe('ClinicianNextAppointment', () => {
  it('shows the next scheduled appointment in three zones with its duration', async () => {
    const appt = {
      patientId: 'p1',
      scheduledAt: '2026-09-20T10:00:00.000Z',
      durationMinutes: 45,
      appointment_status: 'scheduled',
    };
    render(
      <ClinicianNextAppointment
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchCalendar={() => ok([appt])}
      />,
    );

    const term = await screen.findByText('Next appointment');
    const value = term.nextElementSibling;
    expect(value?.textContent).not.toContain(appt.scheduledAt);
    expect(value?.textContent).toContain(
      formatDateTimeInZone(appt.scheduledAt, defaultLocale, 'Europe/London'),
    );
    expect(screen.getByText('India')).toBeTruthy();
    expect(screen.getByText('Next appointment length (minutes)').nextElementSibling?.textContent).toBe(
      '45',
    );
  });

  it('picks the earliest upcoming, skipping past and unconfirmed appointments', async () => {
    const items = [
      // already over
      { patientId: 'a', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30, appointment_status: 'scheduled' },
      // later than the winner
      { patientId: 'b', scheduledAt: '2026-09-25T10:00:00.000Z', durationMinutes: 30, appointment_status: 'scheduled' },
      // sooner, but not yet confirmed — no call to join, so not "next"
      { patientId: 'c', scheduledAt: '2026-09-20T10:00:00.000Z', durationMinutes: 60, appointment_status: 'pending-approval' },
      // the earliest upcoming *scheduled* one
      { patientId: 'd', scheduledAt: '2026-09-22T10:00:00.000Z', durationMinutes: 50, appointment_status: 'scheduled' },
    ];
    render(
      <ClinicianNextAppointment
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchCalendar={() => ok(items)}
      />,
    );

    await screen.findByText('Next appointment');
    expect(screen.getByText('Next appointment length (minutes)').nextElementSibling?.textContent).toBe(
      '50',
    );
  });

  it('shows the empty note when nothing is upcoming', async () => {
    render(
      <ClinicianNextAppointment
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchCalendar={() => ok([])}
      />,
    );

    expect(await screen.findByText('No appointment is booked yet.')).toBeTruthy();
  });

  it('renders nothing when the calendar cannot be read', async () => {
    const { container } = render(
      <ClinicianNextAppointment
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchCalendar={() => Promise.resolve({ ok: false, status: 403 } as Response)}
      />,
    );

    await waitFor(() => expect(container.querySelector('.ndn-record-lead')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('queries a bounded forward window starting from now', async () => {
    let captured: { from: string; to: string } | undefined;
    render(
      <ClinicianNextAppointment
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchCalendar={(from, to) => {
          captured = { from, to };
          return ok([]);
        }}
      />,
    );

    await screen.findByText('No appointment is booked yet.');
    expect(captured?.from).toBe(NOW);
    // LOOKAHEAD_DAYS (366) later — a bounded range, which the endpoint requires.
    expect(captured?.to).toBe('2027-09-19T06:00:00.000Z');
  });
});
