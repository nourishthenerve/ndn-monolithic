// @vitest-environment jsdom
//
// 2026-09-03: the patient half of the bug the owner reported. *"When the
// item of appointment arrived the 'join the call' button simply didnt
// appear for both the patient as well as the clinician. The dashboard
// simply started showing the next appointment item."*
//
// `NextAppointmentPanel.test.ts` covers `findNext` directly and stays as
// it is. What it could not reach is the thing the patient actually looks
// at — whether a *link* is on the screen at the moment the appointment
// starts — and that is the whole of the report. The panel's own second
// half of the fix is only visible here too: which appointment is "next" is
// now derived from the ticking clock on every render, not frozen at the
// moment the fetch landed.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { NextAppointmentPanel } from './NextAppointmentPanel.js';
import type { AppointmentEntry, NextAppointmentPanelStrings } from './NextAppointmentPanel.js';

afterEach(cleanup);

const STRINGS: NextAppointmentPanelStrings = {
  heading: 'Your next appointment',
  loadingLabel: 'Loading…',
  forbiddenLabel: 'You do not have access to this.',
  errorLabel: 'Something went wrong.',
  emptyLabel: 'You have no upcoming appointment scheduled.',
  durationLabel: 'Duration (minutes):',
  joinCallLabel: 'Join this call',
};

const client = { authorization: () => Promise.resolve('a.b.c') } as never;

const SLOT = '2026-09-01T10:00:00.000Z';
const LATER = '2026-09-05T14:00:00.000Z';

/**
 * Every clock is a module-level constant, and that is load-bearing rather
 * than tidy: `useNow` takes the function in a dependency array, so a fresh
 * arrow per render is the unbounded-re-render shape this directory has
 * already been bitten by once. See `useNow.ts`.
 */
const beforeTheSlot = () => new Date('2026-09-01T09:30:00.000Z');
const atTheStart = () => new Date(SLOT);
const midSlot = () => new Date('2026-09-01T10:15:00.000Z');
const afterTheSlot = () => new Date('2026-09-01T10:30:00.000Z');

function entry(overrides: Partial<AppointmentEntry> = {}): AppointmentEntry {
  return {
    patientId: 'pat-1',
    scheduledAt: SLOT,
    durationMinutes: 30,
    appointment_status: 'scheduled',
    ...overrides,
  };
}

function ok(items: readonly AppointmentEntry[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ items }),
  } as Response);
}

function panel(now: () => Date, items: readonly AppointmentEntry[]) {
  return (
    <NextAppointmentPanel
      strings={STRINGS}
      locale="en"
      client={client}
      now={now}
      fetchAppointments={() => ok(items)}
    />
  );
}

describe('the join link, across the life of one appointment', () => {
  it('is on screen the moment the appointment starts — the reported bug', async () => {
    render(panel(atTheStart, [entry()]));
    expect(await screen.findByRole('link', { name: STRINGS.joinCallLabel })).toBeDefined();
  });

  it('is still there midway through', async () => {
    render(panel(midSlot, [entry()]));
    expect(await screen.findByRole('link', { name: STRINGS.joinCallLabel })).toBeDefined();
  });

  it('is a countdown, not a link, before the appointment starts', async () => {
    render(panel(beforeTheSlot, [entry()]));
    // "Starts in 30 minutes" — the appointment is named, the link is not
    // offered, and the server would refuse it if it were.
    expect(await screen.findByText(/Starts in/)).toBeDefined();
    expect(screen.queryByRole('link', { name: STRINGS.joinCallLabel })).toBeNull();
  });

  it('hands over to the following appointment once the slot ends, rather than sticking on the finished one', async () => {
    const { container } = render(panel(afterTheSlot, [entry(), entry({ scheduledAt: LATER })]));
    // The finished appointment is gone from the panel; the next real one
    // is named, with its own countdown rather than a link.
    expect(await screen.findByText(/Starts in/)).toBeDefined();
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(LATER);
  });

  it('says there is nothing coming when every appointment has finished', async () => {
    render(panel(afterTheSlot, [entry()]));
    expect(await screen.findByText(STRINGS.emptyLabel)).toBeDefined();
  });
});

describe('how the time itself reads', () => {
  it('spells the month, so the date cannot be read two ways', async () => {
    const { container } = render(panel(midSlot, [entry()]));
    await screen.findByRole('link', { name: STRINGS.joinCallLabel });
    // `9/3/2026` versus `03/09/2026` — the same instant rendered on two
    // screens of this app, disagreeing about the month. See
    // `packages/i18n/src/datetime.ts`.
    const rendered = container.querySelector('time')?.textContent ?? '';
    expect(rendered).toContain('September');
    expect(rendered).not.toMatch(/\d+\/\d+/);
  });

  it('carries the raw UTC instant machine-readably alongside it', async () => {
    const { container } = render(panel(midSlot, [entry()]));
    await screen.findByRole('link', { name: STRINGS.joinCallLabel });
    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(SLOT);
  });
});

describe('states that are not an appointment', () => {
  it('treats a 403 as an ordinary outcome', async () => {
    render(
      <NextAppointmentPanel
        strings={STRINGS}
        locale="en"
        client={client}
        now={midSlot}
        fetchAppointments={() => Promise.resolve({ ok: false, status: 403 } as Response)}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('shows the error state when the request fails', async () => {
    render(
      <NextAppointmentPanel
        strings={STRINGS}
        locale="en"
        client={client}
        now={midSlot}
        fetchAppointments={() => Promise.reject(new Error('network'))}
      />,
    );
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
  });
});
