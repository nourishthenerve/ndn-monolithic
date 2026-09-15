// @vitest-environment jsdom
//
// 2026-09-14: the principal's pending-approvals queue. These hold the two
// things a stylesheet cannot: that a row names who and when the principal is
// approving, and that accepting one collapses it out of the list — the
// owner's *"he simply has to click Accept … and the rows will collapse"* —
// while a failed decision leaves the row where it was.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PendingApprovalsPanel } from './PendingApprovalsPanel.js';
import type { PendingApproval, PendingApprovalsStrings } from './PendingApprovalsPanel.js';

afterEach(cleanup);

const STRINGS: PendingApprovalsStrings = {
  heading: 'Pending approvals',
  errorLabel: 'Could not load the queue.',
  patientColumnLabel: 'Patient',
  clinicianColumnLabel: 'Assigned clinician',
  whenColumnLabel: 'When',
  decisionColumnLabel: 'Decision',
  caption: 'Appointments waiting for you to approve them',
  acceptButton: 'Accept',
  declineButton: 'Decline',
  working: 'Saving…',
  decideFailed: 'That could not be saved.',
  unnamedPatient: 'This patient',
  unassignedLabel: 'Nobody yet',
};

function pending(
  overrides: Partial<PendingApproval> & { patientId: string; scheduledAt: string },
): PendingApproval {
  return {
    durationMinutes: 30,
    appointment_status: 'pending-approval',
    patientName: `Patient ${overrides.patientId}`,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const session = {
  resolve: () =>
    Promise.resolve({ status: 'signed-in', session: { viewerRole: 'principal-clinician' } }),
  authorization: () => Promise.resolve('token'),
  complete: () => Promise.resolve({ status: 'signed-out' }),
  signOut: () => Promise.resolve(undefined),
} as never;

function renderPanel(
  items: readonly PendingApproval[],
  decide = vi.fn().mockResolvedValue(jsonResponse({ item: {} })),
) {
  const fetchPending = vi.fn().mockResolvedValue(jsonResponse({ items }));
  render(
    <PendingApprovalsPanel
      strings={STRINGS}
      locale="en"
      client={session}
      fetchPending={fetchPending}
      decide={decide}
    />,
  );
  return { fetchPending, decide };
}

async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name);
  const row = cell.closest('tr');
  if (!row) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

describe('what a row says', () => {
  it('names the patient and the clinician whose session is being approved', async () => {
    renderPanel([
      pending({
        patientId: 'p1',
        scheduledAt: '2026-09-01T10:00:00.000Z',
        patientName: 'Alex Kim',
        assignedClinicianName: 'Dr Ada',
      }),
    ]);
    const row = await rowFor('Alex Kim');
    expect(within(row).getByText('Dr Ada')).toBeDefined();
  });

  it('says "nobody yet" rather than leaving the clinician cell blank', async () => {
    renderPanel([
      pending({ patientId: 'p1', scheduledAt: '2026-09-01T10:00:00.000Z', patientName: 'Sam Lee' }),
    ]);
    expect(within(await rowFor('Sam Lee')).getByText('Nobody yet')).toBeDefined();
  });
});

describe('accepting a row', () => {
  it('approves and then collapses the row out of the list', async () => {
    const decide = vi.fn().mockResolvedValue(jsonResponse({ item: {} }));
    renderPanel(
      [
        pending({
          patientId: 'p1',
          scheduledAt: '2026-09-01T10:00:00.000Z',
          patientName: 'Alex Kim',
        }),
        pending({
          patientId: 'p2',
          scheduledAt: '2026-09-02T10:00:00.000Z',
          patientName: 'Sam Lee',
        }),
      ],
      decide,
    );
    const row = await rowFor('Alex Kim');
    fireEvent.click(within(row).getByRole('button', { name: 'Accept — Alex Kim' }));

    await waitFor(() => expect(screen.queryByText('Alex Kim')).toBeNull());
    // The other row is untouched — one decision removes exactly one row.
    expect(screen.getByText('Sam Lee')).toBeDefined();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]?.[2]).toBe('approve');
  });

  it('disappears entirely once the last row is accepted', async () => {
    renderPanel([
      pending({
        patientId: 'p1',
        scheduledAt: '2026-09-01T10:00:00.000Z',
        patientName: 'Alex Kim',
      }),
    ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept — Alex Kim' }));
    await waitFor(() => expect(screen.queryByText('Pending approvals')).toBeNull());
  });

  it('keeps the row and says so when the decision does not save', async () => {
    const decide = vi.fn().mockResolvedValue(jsonResponse({ error: 'CONFLICT' }, 409));
    renderPanel(
      [
        pending({
          patientId: 'p1',
          scheduledAt: '2026-09-01T10:00:00.000Z',
          patientName: 'Alex Kim',
        }),
      ],
      decide,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Accept — Alex Kim' }));
    expect(await screen.findByText('That could not be saved.')).toBeDefined();
    expect(screen.getByText('Alex Kim')).toBeDefined();
  });

  it('can decline as well as accept', async () => {
    const decide = vi.fn().mockResolvedValue(jsonResponse({ item: {} }));
    renderPanel(
      [
        pending({
          patientId: 'p1',
          scheduledAt: '2026-09-01T10:00:00.000Z',
          patientName: 'Alex Kim',
        }),
      ],
      decide,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Decline — Alex Kim' }));
    await waitFor(() => expect(screen.queryByText('Alex Kim')).toBeNull());
    expect(decide.mock.calls[0]?.[2]).toBe('decline');
  });
});

describe('states that render nothing', () => {
  it('shows no band at all when the queue is empty', async () => {
    const { fetchPending } = renderPanel([]);
    await waitFor(() => expect(fetchPending).toHaveBeenCalled());
    expect(screen.queryByText('Pending approvals')).toBeNull();
  });

  it('stays silent on a refusal rather than explaining an absent section', async () => {
    const fetchPending = vi.fn().mockResolvedValue(jsonResponse({}, 403));
    render(
      <PendingApprovalsPanel
        strings={STRINGS}
        locale="en"
        client={session}
        fetchPending={fetchPending}
        decide={vi.fn()}
      />,
    );
    await waitFor(() => expect(fetchPending).toHaveBeenCalled());
    expect(screen.queryByText('Pending approvals')).toBeNull();
    expect(screen.queryByText('Could not load the queue.')).toBeNull();
  });

  it('does report a genuine load failure', async () => {
    const fetchPending = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    render(
      <PendingApprovalsPanel
        strings={STRINGS}
        locale="en"
        client={session}
        fetchPending={fetchPending}
        decide={vi.fn()}
      />,
    );
    expect(await screen.findByText('Could not load the queue.')).toBeDefined();
  });
});
