// @vitest-environment jsdom
//
// 2026-09-03: the join column, and the role gate on it.
//
// This panel had no test of any kind. It gets one now because it is the
// screen the clinician was on when they reported that no join button
// appeared: the only place in the app that lists a *named* patient's
// appointments, and until today it listed them with no way to reach a call
// from any row. `/account/calendar` had the link, and nothing in the app
// pointed at that page.
//
// The gate matters as much as the link. `authz-matrix.ts`'s `Appointments`
// row grants `join-call` to both clinician columns and to `Principal`, and
// withholds it from `Helpdesk` and `Visitor` — and this page is
// deliberately reachable by a helpdesk account. A link the socket refuses
// is the same mistake the approval buttons made in 2026-09-02.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PatientRecordPanel } from './PatientRecordPanel.js';
import type { PatientRecordPanelStrings } from './PatientRecordPanel.js';

afterEach(cleanup);

const STRINGS: PatientRecordPanelStrings = {
  loadingLabel: 'Loading…',
  forbiddenLabel: 'You do not have access to this.',
  notFoundLabel: 'No such patient.',
  errorLabel: 'Something went wrong.',
  missingIdLabel: 'Choose a patient from the dashboard.',
  detailsHeading: 'Patient details',
  fullNameLabel: 'Full name',
  emailLabel: 'Email',
  phoneLabel: 'Phone',
  marketingOptInLabel: 'Marketing opt-in',
  statusLabel: 'Status',
  assignedClinicianLabel: 'Assigned clinician',
  unassignedLabel: 'Unassigned',
  saveButton: 'Save',
  saving: 'Saving…',
  savedMessage: 'Saved.',
  statusPendingLabel: 'Pending',
  statusApprovedLabel: 'Approved',
  statusDeclinedLabel: 'Declined',
  statusSuspendedLabel: 'Suspended',
  appointmentsHeading: 'Appointments',
  appointmentsEmpty: 'No appointments.',
  appointmentsError: 'Appointments could not be loaded.',
  whenColumnLabel: 'When',
  durationColumnLabel: 'Duration',
  appointmentStatusColumnLabel: 'Status',
  minutesSuffix: 'minutes',
  decisionColumnLabel: 'Decision',
  approveButton: 'Approve',
  declineButton: 'Decline',
  decideFailedLabel: 'That could not be saved.',
  joinCallLabel: 'Join call',
  backToDashboard: 'Back to dashboard',
};

const TOKEN = 'a.b.c';
const PATIENT_ID = 'pat-1';
const SLOT = '2026-09-01T10:00:00.000Z';

/** Stable references — `useNow` reads them in a dependency array. */
const midSlot = () => new Date('2026-09-01T10:15:00.000Z');
const beforeTheSlot = () => new Date('2026-09-01T09:30:00.000Z');
const afterTheSlot = () => new Date('2026-09-01T10:30:00.000Z');

function clientAs(viewerRole: string | undefined) {
  return {
    authorization: () => Promise.resolve(TOKEN),
    resolve: () => Promise.resolve({ status: 'signed-in', session: { viewerRole } }),
  } as never;
}

function patientOk(): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        item: {
          id: PATIENT_ID,
          account_status: 'approved',
          assigned_clinician_id: 'cli-1',
          personal: { fullName: 'Test Patient 1', email: 't@example.com', marketingOptIn: false },
        },
      }),
  } as Response);
}

interface Appt {
  readonly scheduledAt: string;
  readonly durationMinutes: number;
  readonly appointment_status: string;
}

function appointmentsOk(items: readonly Appt[]): () => Promise<Response> {
  return () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ items }),
    } as Response);
}

const scheduled: Appt = {
  scheduledAt: SLOT,
  durationMinutes: 30,
  appointment_status: 'scheduled',
};

function panel(
  viewerRole: string | undefined,
  now: () => Date,
  items: readonly Appt[] = [scheduled],
) {
  return (
    <PatientRecordPanel
      strings={STRINGS}
      dashboardHref="/en/account/caseload"
      locale="en"
      patientId={PATIENT_ID}
      client={clientAs(viewerRole)}
      fetchPatient={patientOk}
      fetchAppointments={appointmentsOk(items)}
      now={now}
    />
  );
}

describe('the join link on a named patient’s appointments', () => {
  it('is on screen while the appointment is running — the reported bug', async () => {
    render(panel('sub-clinician', midSlot));
    const link = await screen.findByRole('link', { name: STRINGS.joinCallLabel });
    // It points at the call page with the composite id `ws-join.ts` parses.
    expect(link.getAttribute('href')).toBe(
      `/en/account/call?appointmentId=${encodeURIComponent(`${PATIENT_ID}#${SLOT}`)}`,
    );
  });

  it('is a countdown before the appointment starts, not a link', async () => {
    render(panel('sub-clinician', beforeTheSlot));
    expect(await screen.findByText(/Starts in/)).toBeDefined();
    expect(screen.queryByRole('link', { name: STRINGS.joinCallLabel })).toBeNull();
  });

  it('says "Expired" once the booked slot has ended', async () => {
    render(panel('sub-clinician', afterTheSlot));
    expect(await screen.findByText('Expired')).toBeDefined();
    expect(screen.queryByRole('link', { name: STRINGS.joinCallLabel })).toBeNull();
  });

  it('is offered to the principal too — they are a practising clinician here', async () => {
    render(panel('principal-clinician', midSlot));
    expect(await screen.findByRole('link', { name: STRINGS.joinCallLabel })).toBeDefined();
  });

  it.each([['helpdesk'], ['visitor']])(
    'is offered to nobody who cannot join — %s',
    async (role) => {
      render(panel(role, midSlot));
      // The row is still there and still says what it is; only the link
      // is absent. `Appointments` grants them plain `read`, and a link the
      // socket would refuse is worse than none.
      await screen.findByText('scheduled');
      expect(screen.queryByRole('link', { name: STRINGS.joinCallLabel })).toBeNull();
    },
  );

  it('still offers it when the token cannot be read — hide on a positive answer, never on a shrug', async () => {
    render(panel(undefined, midSlot));
    expect(await screen.findByRole('link', { name: STRINGS.joinCallLabel })).toBeDefined();
  });

  it.each([['pending-approval'], ['cancelled'], ['completed'], ['no-show']])(
    'offers nothing on a %s row — there is no call to join',
    async (appointment_status) => {
      render(panel('sub-clinician', midSlot, [{ ...scheduled, appointment_status }]));
      await screen.findByText(appointment_status);
      expect(screen.queryByRole('link', { name: STRINGS.joinCallLabel })).toBeNull();
      expect(screen.queryByText('Expired')).toBeNull();
    },
  );
});

describe('how the appointment time reads', () => {
  it('spells the month, so this screen and the patient’s own cannot disagree', async () => {
    const { container } = render(panel('sub-clinician', midSlot));
    await screen.findByRole('link', { name: STRINGS.joinCallLabel });
    const rendered = container.querySelector('time')?.textContent ?? '';
    expect(rendered).toContain('September');
    expect(rendered).not.toMatch(/\d+\/\d+/);
  });
});

// The rest of this panel, which had no test at all before today. Not
// coverage for its own sake: importing this component put its whole module
// graph on the repo's 80% branch gate (`video-calls.md` records the same
// thing happening to `VideoCall.tsx`), and a screen that staff edit patient
// details on should not be reaching that gate untested either way.

/** The panel with everything injectable, so each test names only what it is about. */
function fullPanel(overrides: Record<string, unknown> = {}) {
  return (
    <PatientRecordPanel
      strings={STRINGS}
      dashboardHref="/en/account/caseload"
      locale="en"
      patientId={PATIENT_ID}
      client={clientAs('principal-clinician')}
      fetchPatient={patientOk}
      fetchAppointments={appointmentsOk([])}
      now={midSlot}
      {...overrides}
    />
  );
}

describe('reaching the record at all', () => {
  it('asks for a patient when the URL names none, rather than failing at a fetch', async () => {
    render(fullPanel({ patientId: '' }));
    expect(await screen.findByText(STRINGS.missingIdLabel)).toBeDefined();
  });

  it.each([
    ['a 403 — a role that cannot read this patient', 403, () => STRINGS.forbiddenLabel],
    ['a 404 — no such patient', 404, () => STRINGS.notFoundLabel],
    ['a 500', 500, () => STRINGS.errorLabel],
  ])('reports %s', async (_label, status, expected) => {
    render(
      fullPanel({
        fetchPatient: () => Promise.resolve({ ok: false, status } as Response),
      }),
    );
    expect(await screen.findByText(expected())).toBeDefined();
  });

  it('reports an error when the request itself throws', async () => {
    render(fullPanel({ fetchPatient: () => Promise.reject(new Error('network')) }));
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
  });

  it('is forbidden with no session at all', async () => {
    render(
      fullPanel({
        client: { authorization: () => Promise.resolve(undefined), resolve: () => Promise.resolve({ status: 'signed-out' }) } as never,
      }),
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it.each([
    ['pending', 'Pending'],
    ['declined', 'Declined'],
    ['suspended', 'Suspended'],
  ])('names the %s account status in words, not the raw value', async (accountStatus, label) => {
    render(
      fullPanel({
        fetchPatient: () =>
          Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                item: {
                  id: PATIENT_ID,
                  account_status: accountStatus,
                  personal: { fullName: 'Test Patient 1', email: 't@example.com', marketingOptIn: false },
                },
              }),
          } as Response),
      }),
    );
    expect(await screen.findByText(label)).toBeDefined();
    // No `assigned_clinician_id` on that record either — the unassigned
    // fallback, not a blank cell.
    expect(screen.getByText(STRINGS.unassignedLabel)).toBeDefined();
  });
});

describe('editing the details', () => {
  it('saves the edited name, and sends a blank phone as absent rather than as ""', async () => {
    const savePatient = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    render(fullPanel({ savePatient }));
    const name = await screen.findByLabelText(STRINGS.fullNameLabel);
    fireEvent.change(name, { target: { value: 'Renamed Patient' } });
    fireEvent.click(screen.getByRole('button', { name: STRINGS.saveButton }));

    await waitFor(() => {
      expect(savePatient).toHaveBeenCalledWith(TOKEN, PATIENT_ID, {
        // "No phone was given" and "phone is blank" are different facts.
        personal: { fullName: 'Renamed Patient', marketingOptIn: false },
      });
    });
    expect(await screen.findByText(STRINGS.savedMessage)).toBeDefined();
  });

  it('sends a phone that was actually typed', async () => {
    const savePatient = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    render(fullPanel({ savePatient }));
    fireEvent.change(await screen.findByLabelText(STRINGS.phoneLabel), {
      target: { value: ' 07700 900000 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: STRINGS.saveButton }));
    await waitFor(() => {
      expect(savePatient).toHaveBeenCalledWith(
        TOKEN,
        PATIENT_ID,
        expect.objectContaining({
          personal: expect.objectContaining({ phone: '07700 900000' }),
        }),
      );
    });
  });

  it('clears the saved message once the form is edited again', async () => {
    render(fullPanel({ savePatient: () => Promise.resolve({ ok: true, status: 200 } as Response) }));
    const name = await screen.findByLabelText(STRINGS.fullNameLabel);
    fireEvent.click(screen.getByRole('button', { name: STRINGS.saveButton }));
    await screen.findByText(STRINGS.savedMessage);
    fireEvent.change(name, { target: { value: 'Edited Again' } });
    expect(screen.queryByText(STRINGS.savedMessage)).toBeNull();
  });

  it('will not submit an empty name', async () => {
    render(fullPanel());
    const name = await screen.findByLabelText(STRINGS.fullNameLabel);
    fireEvent.change(name, { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: STRINGS.saveButton }).hasAttribute('disabled')).toBe(
      true,
    );
  });

  it.each([
    ['a 403 — the helpdesk may read but not write this field', 403, () => STRINGS.forbiddenLabel],
    ['a 500', 500, () => STRINGS.errorLabel],
  ])('reports %s from the save', async (_label, status, expected) => {
    render(fullPanel({ savePatient: () => Promise.resolve({ ok: false, status } as Response) }));
    await screen.findByLabelText(STRINGS.fullNameLabel);
    fireEvent.click(screen.getByRole('button', { name: STRINGS.saveButton }));
    expect(await screen.findByText(expected())).toBeDefined();
  });

  it('reports an error when the save itself throws', async () => {
    render(fullPanel({ savePatient: () => Promise.reject(new Error('network')) }));
    await screen.findByLabelText(STRINGS.fullNameLabel);
    fireEvent.click(screen.getByRole('button', { name: STRINGS.saveButton }));
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
  });
});

describe('the appointments list beside the record', () => {
  it('says so when there are none', async () => {
    render(fullPanel());
    expect(await screen.findByText(STRINGS.appointmentsEmpty)).toBeDefined();
  });

  it('reports a failed appointments read without losing the details page', async () => {
    render(
      fullPanel({ fetchAppointments: () => Promise.resolve({ ok: false, status: 403 } as Response) }),
    );
    // A helpdesk account that cannot reach appointments must still get the
    // record itself, not an error screen.
    expect(await screen.findByText(STRINGS.appointmentsError)).toBeDefined();
    expect(screen.getByLabelText(STRINGS.fullNameLabel)).toBeDefined();
  });

  it('reports it when the appointments read throws too', async () => {
    render(fullPanel({ fetchAppointments: () => Promise.reject(new Error('network')) }));
    expect(await screen.findByText(STRINGS.appointmentsError)).toBeDefined();
  });
});

describe('approving a pending booking', () => {
  const pending: Appt = { ...scheduled, appointment_status: 'pending-approval' };

  it('posts the decision against the appointment, then re-reads the list', async () => {
    const decideAppointment = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    let reads = 0;
    render(
      fullPanel({
        decideAppointment,
        fetchAppointments: () => {
          reads += 1;
          return appointmentsOk([pending])();
        },
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.approveButton }));
    await waitFor(() => {
      expect(reads).toBeGreaterThan(1);
    });
    expect(decideAppointment).toHaveBeenCalledWith(TOKEN, PATIENT_ID, SLOT, 'approve');
  });

  it('sends "decline" from the decline button', async () => {
    const decideAppointment = vi.fn(() => Promise.resolve({ ok: true, status: 200 } as Response));
    render(fullPanel({ decideAppointment, fetchAppointments: appointmentsOk([pending]) }));
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.declineButton }));
    await waitFor(() => {
      expect(decideAppointment).toHaveBeenCalledWith(TOKEN, PATIENT_ID, SLOT, 'decline');
    });
  });

  it.each([
    ['a 403 — not the principal', 403],
    ['a 409 — someone decided first', 409],
  ])('reports %s on the same message: this row is not yours to change now', async (_l, status) => {
    render(
      fullPanel({
        decideAppointment: () => Promise.resolve({ ok: false, status } as Response),
        fetchAppointments: appointmentsOk([pending]),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.approveButton }));
    expect(await screen.findByText(STRINGS.decideFailedLabel)).toBeDefined();
  });

  it('reports it when the decision itself throws', async () => {
    render(
      fullPanel({
        decideAppointment: () => Promise.reject(new Error('network')),
        fetchAppointments: appointmentsOk([pending]),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: STRINGS.approveButton }));
    expect(await screen.findByText(STRINGS.decideFailedLabel)).toBeDefined();
  });

  it.each([['sub-clinician'], ['helpdesk']])(
    'offers the controls to nobody but the principal — %s',
    async (role) => {
      render(fullPanel({ client: clientAs(role), fetchAppointments: appointmentsOk([pending]) }));
      await screen.findByText('pending-approval');
      expect(screen.queryByRole('button', { name: STRINGS.approveButton })).toBeNull();
    },
  );
});
