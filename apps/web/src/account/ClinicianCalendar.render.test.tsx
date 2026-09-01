// @vitest-environment jsdom
//
// 2026-09-01: the approval controls, rendered. `ClinicianCalendar.test.ts`
// has covered this component's pure helpers since TASK 5.5.3 and stays as
// it is; what it could not reach is the table itself, and the table is now
// where "any new appointment booked by the clinician needs to be approved
// by the principal clinician" becomes something a person can do.
//
// The distinction worth pinning is **which controls a row gets**, because
// it is per-status and getting it wrong offers a join link for a call that
// cannot happen or an approve button for a decision already made.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClinicianCalendar } from './ClinicianCalendar.js';
import type { CalendarEntry, ClinicianCalendarStrings } from './ClinicianCalendar.js';

afterEach(cleanup);

const STRINGS: ClinicianCalendarStrings = {
  loadingLabel: 'Loading…',
  approveLabel: 'Approve',
  declineLabel: 'Decline',
  completeLabel: 'Mark as attended',
  noShowLabel: 'Mark as no-show',
  decidingLabel: 'Saving…',
  decideFailedLabel: 'That could not be saved.',
  forbiddenLabel: 'You do not have access to this.',
  errorLabel: 'Something went wrong.',
  emptyLabel: 'Nothing in the next 30 days.',
  dateColumnLabel: 'When',
  durationColumnLabel: 'Minutes',
  statusColumnLabel: 'Status',
  joinCallLabel: 'Join this call',
  caption: 'Your calendar',
};

const TOKEN = 'a.b.c';
const client = { authorization: () => Promise.resolve(TOKEN) } as never;

function entry(overrides: Partial<CalendarEntry> = {}): CalendarEntry {
  return {
    patientId: 'pat-1',
    scheduledAt: '2026-09-01T10:00:00.000Z',
    durationMinutes: 30,
    appointment_status: 'scheduled',
    ...overrides,
  };
}

function ok(items: readonly CalendarEntry[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ items }),
  } as Response);
}

describe('which controls a row gets', () => {
  it('offers approve and decline on a pending row, and no join link — there is nothing to join yet', async () => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        fetchCalendar={() => ok([entry({ appointment_status: 'pending-approval' })])}
      />,
    );

    await screen.findByText('pending-approval');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDefined();
    expect(screen.queryByRole('link', { name: 'Join this call' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark as attended' })).toBeNull();
  });

  it('offers a join link and the attendance controls on a confirmed row, and no decision buttons', async () => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        fetchCalendar={() => ok([entry()])}
      />,
    );

    await screen.findByText('scheduled');
    expect(screen.getByRole('link', { name: 'Join this call' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mark as attended' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mark as no-show' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('offers nothing at all on a row that is over — cancelled, completed or a no-show', async () => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        fetchCalendar={() =>
          ok([
            entry({ appointment_status: 'completed', scheduledAt: '2026-09-01T10:00:00.000Z' }),
            entry({ appointment_status: 'no-show', scheduledAt: '2026-09-02T10:00:00.000Z' }),
          ])
        }
      />,
    );

    await screen.findByText('completed');
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('says so when the window holds nothing', async () => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        fetchCalendar={() => ok([])}
      />,
    );
    expect(await screen.findByText(STRINGS.emptyLabel)).toBeDefined();
  });
});

describe('deciding', () => {
  it('posts the decision against the appointment, then reloads', async () => {
    const decideAppointment = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    let fetches = 0;
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        decideAppointment={decideAppointment}
        fetchCalendar={() => {
          fetches += 1;
          return ok([entry({ appointment_status: 'pending-approval' })]);
        }}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      expect(fetches).toBeGreaterThan(1);
    });
    expect(decideAppointment).toHaveBeenCalledWith(
      TOKEN,
      expect.objectContaining({ patientId: 'pat-1' }),
      'approve',
    );
  });

  it('sends "decline" from the decline button, not "approve"', async () => {
    const decideAppointment = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        decideAppointment={decideAppointment}
        fetchCalendar={() => ok([entry({ appointment_status: 'pending-approval' })])}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Decline' }));
    await waitFor(() => {
      expect(decideAppointment).toHaveBeenCalledWith(TOKEN, expect.anything(), 'decline');
    });
  });

  it.each([
    ['a 403 — a sub-clinician pressing approve', 403],
    ['a 409 — someone else decided first', 409],
  ])('reports %s on the row, without losing the rest of the table', async (_label, status) => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        decideAppointment={() => Promise.resolve({ ok: false, status } as Response)}
        fetchCalendar={() =>
          ok([
            entry({ appointment_status: 'pending-approval' }),
            entry({ scheduledAt: '2026-09-02T10:00:00.000Z' }),
          ])
        }
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    expect(await screen.findByText(STRINGS.decideFailedLabel)).toBeDefined();
    // The confirmed row is untouched — one row's outcome never speaks for
    // another's.
    expect(screen.getByRole('link', { name: 'Join this call' })).toBeDefined();
  });

  it('marks attendance from a confirmed row', async () => {
    const decideAppointment = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        decideAppointment={decideAppointment}
        fetchCalendar={() => ok([entry()])}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Mark as no-show' }));
    await waitFor(() => {
      expect(decideAppointment).toHaveBeenCalledWith(TOKEN, expect.anything(), 'no-show');
    });
  });
});

describe('states that are not a table', () => {
  it('treats a 403 as an ordinary outcome', async () => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        fetchCalendar={() => Promise.resolve({ ok: false, status: 403 } as Response)}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('shows the error state when the request fails', async () => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        fetchCalendar={() => Promise.reject(new Error('network'))}
      />,
    );
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
  });

  it('is forbidden with no session at all', async () => {
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={{ authorization: () => Promise.resolve(undefined) } as never}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });
});

// The bug the very first rendered test of this component found, and the one
// this file exists to keep fixed. `now = () => new Date()` as an inline
// default changed identity on every render, so `load`'s `useCallback` was
// rebuilt every render, so the `useEffect` depending on it re-ran every
// render, so its `setState` caused another — an unbounded fetch loop for as
// long as the page was open. It crashed the worker outright.
describe('the fetch runs once, not once per render', () => {
  it('does not re-fetch itself into a loop', async () => {
    let fetches = 0;
    render(
      <ClinicianCalendar
        strings={STRINGS}
        locale="en"
        client={client}
        fetchCalendar={() => {
          fetches += 1;
          return ok([entry()]);
        }}
      />,
    );

    await screen.findByText('scheduled');
    // Settle: anything that was going to re-trigger the effect has had its
    // turn on the microtask queue by now.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetches).toBe(1);
  });
});
