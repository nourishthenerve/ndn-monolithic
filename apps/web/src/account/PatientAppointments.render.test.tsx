// @vitest-environment jsdom
//
// 2026-09-04: the patient's own calendar. *"Make similar My Calender button
// for patient where he can see upcoming appointments and easily join from
// there."*
//
// Two things this page has to get right, and they are the two the patient
// had no way to reach before it: **every** appointment that is still ahead
// (not just the next one), and a link they can actually press at the moment
// it works.
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PatientAppointments, upcomingOf } from './PatientAppointments.js';
import type { AppointmentEntry, PatientAppointmentsStrings } from './PatientAppointments.js';

afterEach(cleanup);

const STRINGS: PatientAppointmentsStrings = {
  heading: 'Upcoming appointments',
  loadingLabel: 'Loading your appointments…',
  forbiddenLabel: 'You do not have access to this page.',
  errorLabel: 'Something went wrong.',
  emptyLabel: 'You have no upcoming appointments.',
  dateColumnLabel: 'Date and time',
  durationColumnLabel: 'Duration (minutes)',
  joinCallLabel: 'Join call',
  caption: 'Upcoming appointments',
};

const client = { authorization: () => Promise.resolve('a.b.c') } as never;

const FIRST = '2026-09-10T14:00:00.000Z';
const SECOND = '2026-09-17T09:30:00.000Z';
const THIRD = '2026-09-24T16:00:00.000Z';

/** Stable references — `useNow` reads them in a dependency array. */
const beforeAll3 = () => new Date('2026-09-09T12:00:00.000Z');
const duringFirst = () => new Date('2026-09-10T14:10:00.000Z');
const afterFirst = () => new Date('2026-09-10T14:45:00.000Z');

function entry(overrides: Partial<AppointmentEntry> = {}): AppointmentEntry {
  return {
    patientId: 'pat-1',
    scheduledAt: FIRST,
    durationMinutes: 30,
    appointment_status: 'scheduled',
    ...overrides,
  };
}

const THREE = [entry(), entry({ scheduledAt: SECOND }), entry({ scheduledAt: THIRD })];

function ok(items: readonly AppointmentEntry[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ items }),
  } as Response);
}

function page(now: () => Date, items: readonly AppointmentEntry[] = THREE) {
  return (
    <PatientAppointments
      strings={STRINGS}
      locale="en"
      client={client}
      now={now}
      fetchAppointments={() => ok(items)}
    />
  );
}

const rows = () => screen.getAllByRole('row').slice(1); // drop the header row

describe('what the patient can finally see', () => {
  it('lists every appointment still ahead, not only the next one', async () => {
    render(page(beforeAll3));
    await screen.findByRole('table');
    // The whole point of the page: `NextAppointmentPanel` showed one of
    // these three and there was nowhere to see the other two.
    expect(rows()).toHaveLength(3);
  });

  it('keeps them in chronological order, as the API returns them', async () => {
    const { container } = render(page(beforeAll3));
    await screen.findByRole('table');
    const times = [...container.querySelectorAll('time')].map((el) => el.getAttribute('datetime'));
    expect(times).toEqual([FIRST, SECOND, THIRD]);
  });

  it('shows each appointment’s booked length', async () => {
    render(page(beforeAll3, [entry({ durationMinutes: 45 })]));
    await screen.findByRole('table');
    expect(within(rows()[0] as HTMLElement).getByText('45')).toBeDefined();
  });

  it('says so, kindly, when there is nothing booked', async () => {
    render(page(beforeAll3, []));
    expect(await screen.findByText(STRINGS.emptyLabel)).toBeDefined();
  });
});

describe('joining from here', () => {
  it('offers a live link on the appointment that is happening now', async () => {
    render(page(duringFirst));
    const link = await screen.findByRole('link', { name: STRINGS.joinCallLabel });
    expect(link.getAttribute('href')).toBe(
      `/en/account/call?appointmentId=${encodeURIComponent(`pat-1#${FIRST}`)}`,
    );
  });

  it('offers a countdown, not a link, on the ones still to come', async () => {
    render(page(beforeAll3));
    await screen.findByRole('table');
    expect(screen.queryByRole('link', { name: STRINGS.joinCallLabel })).toBeNull();
    expect(screen.getAllByText(/Starts in/)).toHaveLength(3);
  });

  it('drops an appointment from the list the moment its slot ends', async () => {
    render(page(afterFirst));
    await screen.findByRole('table');
    // The finished one is gone; "expired" belongs on a page about the
    // past, and this one is about what is coming.
    expect(rows()).toHaveLength(2);
    expect(screen.queryByText('Expired')).toBeNull();
  });
});

describe('what is deliberately not listed', () => {
  it.each([['pending-approval'], ['cancelled'], ['completed'], ['no-show']])(
    'hides a %s appointment',
    async (appointment_status) => {
      render(page(beforeAll3, [entry({ appointment_status }), entry({ scheduledAt: SECOND })]));
      await screen.findByRole('table');
      expect(rows()).toHaveLength(1);
    },
  );

  it('hides a pending booking even when it is the only one — an unapproved slot is not an appointment yet', async () => {
    // The owner, 2026-09-02: "I only want to see confirmed appointments."
    render(page(beforeAll3, [entry({ appointment_status: 'pending-approval' })]));
    expect(await screen.findByText(STRINGS.emptyLabel)).toBeDefined();
  });
});

describe('how the time reads', () => {
  it('spells the month, so this page and the clinician’s cannot disagree', async () => {
    const { container } = render(page(beforeAll3, [entry()]));
    await screen.findByRole('table');
    const rendered = container.querySelector('time')?.textContent ?? '';
    expect(rendered).toContain('September');
    expect(rendered).not.toMatch(/\d+\/\d+/);
  });
});

describe('states that are not a list', () => {
  it('treats a 403 as an ordinary outcome — a clinician who lands here', async () => {
    render(
      <PatientAppointments
        strings={STRINGS}
        locale="en"
        client={client}
        now={beforeAll3}
        fetchAppointments={() => Promise.resolve({ ok: false, status: 403 } as Response)}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('shows the error state when the request fails', async () => {
    render(
      <PatientAppointments
        strings={STRINGS}
        locale="en"
        client={client}
        now={beforeAll3}
        fetchAppointments={() => Promise.reject(new Error('network'))}
      />,
    );
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
  });

  it('is forbidden with no session at all', async () => {
    render(
      <PatientAppointments
        strings={STRINGS}
        locale="en"
        client={{ authorization: () => Promise.resolve(undefined) } as never}
        now={beforeAll3}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('does not re-fetch itself into a loop', async () => {
    // The bug this directory has already been bitten by: an unstable `now`
    // in a `useCallback` dependency array turned a clock into an unbounded
    // fetch against the API. See `useNow.ts`.
    let fetches = 0;
    render(
      <PatientAppointments
        strings={STRINGS}
        locale="en"
        client={client}
        now={beforeAll3}
        fetchAppointments={() => {
          fetches += 1;
          return ok(THREE);
        }}
      />,
    );
    await screen.findByRole('table');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches).toBe(1);
  });
});

describe('upcomingOf', () => {
  const at = (iso: string) => new Date(iso);

  it('keeps an appointment that is under way right now', () => {
    // The one moment its join link works, and the moment a "starts in the
    // future" test would have dropped it — the 2026-09-03 regression.
    expect(upcomingOf([entry()], at(FIRST))).toHaveLength(1);
    expect(upcomingOf([entry()], at('2026-09-10T14:29:59.999Z'))).toHaveLength(1);
  });

  it('drops it exactly at the end of its booked slot', () => {
    expect(upcomingOf([entry()], at('2026-09-10T14:30:00.000Z'))).toHaveLength(0);
  });

  it('measures the end from the booked length, not a fixed one', () => {
    const long = [entry({ durationMinutes: 90 })];
    expect(upcomingOf(long, at('2026-09-10T15:00:00.000Z'))).toHaveLength(1);
    expect(upcomingOf(long, at('2026-09-10T15:30:00.000Z'))).toHaveLength(0);
  });

  it('never keeps a row whose time cannot be read', () => {
    expect(upcomingOf([entry({ scheduledAt: 'not-a-date' })], at(FIRST))).toHaveLength(0);
  });

  it('is empty for an empty list', () => {
    expect(upcomingOf([], at(FIRST))).toEqual([]);
  });
});
