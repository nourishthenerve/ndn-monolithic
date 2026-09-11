// @vitest-environment jsdom
//
// 2026-09-11: the shared next-appointment lead. `findNext` and the
// three-zone/countdown rendering are tested where they live; what this pins
// is the plumbing this component adds — that it reads the right calendar for
// the audience, picks the earliest upcoming scheduled appointment, and names
// the right counterparty (the patient for a clinician, the clinician for a
// patient), showing that line only when a name came back.
import { defaultLocale, formatDateTimeInZone } from '@ndn/i18n';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NextAppointmentLead } from './NextAppointmentLead.js';

afterEach(cleanup);

const STRINGS = {
  appointmentLabel: 'Next appointment',
  durationLabel: 'Next appointment length (minutes)',
  personLabel: 'Person',
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
const ISO = '2026-09-20T10:00:00.000Z';

describe('NextAppointmentLead', () => {
  it('names the patient on a clinician box, in three zones with the duration', async () => {
    const appt = {
      patientId: 'p1',
      patientName: 'Jordan Ellis',
      clinicianName: 'Dr Amelia Ford',
      scheduledAt: ISO,
      durationMinutes: 45,
      appointment_status: 'scheduled',
    };
    render(
      <NextAppointmentLead
        audience="clinician"
        locale={defaultLocale}
        strings={{ ...STRINGS, personLabel: 'Patient' }}
        client={client('tok')}
        now={at(NOW)}
        fetchAppointments={() => ok([appt])}
      />,
    );

    const term = await screen.findByText('Next appointment');
    const value = term.nextElementSibling;
    expect(value?.textContent).not.toContain(ISO);
    expect(value?.textContent).toContain(formatDateTimeInZone(ISO, defaultLocale, 'Europe/London'));
    // The clinician's box names the *patient*, not the clinician.
    expect(screen.getByText('Patient').nextElementSibling?.textContent).toBe('Jordan Ellis');
    expect(screen.queryByText('Dr Amelia Ford')).toBeNull();
    expect(screen.getByText('Next appointment length (minutes)').nextElementSibling?.textContent).toBe(
      '45',
    );
  });

  it('names the clinician on a patient box', async () => {
    const appt = {
      patientId: 'p1',
      patientName: 'Jordan Ellis',
      clinicianName: 'Dr Amelia Ford',
      scheduledAt: ISO,
      durationMinutes: 45,
      appointment_status: 'scheduled',
    };
    render(
      <NextAppointmentLead
        audience="patient"
        locale={defaultLocale}
        strings={{ ...STRINGS, personLabel: 'Clinician' }}
        client={client('tok')}
        now={at(NOW)}
        fetchAppointments={() => ok([appt])}
      />,
    );

    await screen.findByText('Next appointment');
    // The patient's box names the *clinician*, not the patient.
    expect(screen.getByText('Clinician').nextElementSibling?.textContent).toBe('Dr Amelia Ford');
    expect(screen.queryByText('Jordan Ellis')).toBeNull();
  });

  it('picks the earliest upcoming, skipping past and unconfirmed appointments', async () => {
    const items = [
      { patientId: 'a', scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30, appointment_status: 'scheduled' },
      { patientId: 'b', scheduledAt: '2026-09-25T10:00:00.000Z', durationMinutes: 30, appointment_status: 'scheduled' },
      { patientId: 'c', scheduledAt: '2026-09-20T10:00:00.000Z', durationMinutes: 60, appointment_status: 'pending-approval' },
      { patientId: 'd', scheduledAt: '2026-09-22T10:00:00.000Z', durationMinutes: 50, appointment_status: 'scheduled' },
    ];
    render(
      <NextAppointmentLead
        audience="patient"
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchAppointments={() => ok(items)}
      />,
    );

    await screen.findByText('Next appointment');
    expect(screen.getByText('Next appointment length (minutes)').nextElementSibling?.textContent).toBe(
      '50',
    );
  });

  it('omits the counterparty line when the server disclosed no name', async () => {
    const appt = {
      patientId: 'p1',
      scheduledAt: ISO,
      durationMinutes: 45,
      appointment_status: 'scheduled',
    };
    render(
      <NextAppointmentLead
        audience="clinician"
        locale={defaultLocale}
        strings={{ ...STRINGS, personLabel: 'Patient' }}
        client={client('tok')}
        now={at(NOW)}
        fetchAppointments={() => ok([appt])}
      />,
    );

    await screen.findByText('Next appointment');
    expect(screen.queryByText('Patient')).toBeNull();
  });

  it('shows the empty note when nothing is upcoming', async () => {
    render(
      <NextAppointmentLead
        audience="patient"
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchAppointments={() => ok([])}
      />,
    );

    expect(await screen.findByText('No appointment is booked yet.')).toBeTruthy();
  });

  it('renders nothing when the calendar cannot be read', async () => {
    const { container } = render(
      <NextAppointmentLead
        audience="clinician"
        locale={defaultLocale}
        strings={STRINGS}
        client={client('tok')}
        now={at(NOW)}
        fetchAppointments={() => Promise.resolve({ ok: false, status: 403 } as Response)}
      />,
    );

    await waitFor(() => expect(container.querySelector('.ndn-record-lead')).toBeNull());
    expect(container.textContent).toBe('');
  });
});
