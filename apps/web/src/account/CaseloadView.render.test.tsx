// @vitest-environment jsdom
//
// 2026-09-06: this component had **no tests at all** — it predates the point
// where this directory started rendering components in its suites, and its
// own header records that the first rendered test of a sibling crashed a
// worker.
//
// It gets some now because the owner asked for what it is *for*: *"for
// Patient Dashboard, I need a nicely looking table so that I see which
// patients are assigned for a given clinician."* Styling is the visible half
// of that; these tests hold the half a stylesheet cannot — that every row
// actually says who holds that patient, and that "nobody" is stated rather
// than left blank.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CaseloadView } from './CaseloadView.js';
import type { CaseloadEntry, CaseloadViewStrings } from './CaseloadView.js';

afterEach(cleanup);

const STRINGS: CaseloadViewStrings = {
  loadingLabel: 'Loading…',
  forbiddenLabel: 'No access.',
  errorLabel: 'Failed.',
  emptyLabel: 'No patients yet.',
  patientColumnLabel: 'Patient',
  statusColumnLabel: 'Status',
  clinicianColumnLabel: 'Clinician',
  assignColumnLabel: 'Assign',
  nextPageLabel: 'Next',
  previousPageLabel: 'Previous',
  caption: 'Every patient, with the clinician they are assigned to',
  pagerLabel: 'Patient list pages',
  totalPatientsLabel: 'Total patients',
  activePatientsLabel: 'Active patients',
  statusPendingLabel: 'Pending',
  statusApprovedLabel: 'Approved',
  statusDeclinedLabel: 'Declined',
  statusSuspendedLabel: 'Suspended',
  unassignedLabel: 'Unassigned',
  chooseClinicianLabel: 'Choose a clinician',
  assignButton: 'Assign',
  reassignButton: 'Reassign',
  working: 'Working…',
  assignError: 'Could not assign.',
  noCliniciansLabel: 'No clinicians',
  openRecordLabel: 'Open record',
  removeColumnLabel: 'Remove',
  suspendButton: 'Suspend',
  restoreButton: 'Restore',
  suspendConfirm: 'Sure?',
  statusError: 'Could not change status.',
  addressColumnLabel: 'Address',
  appointmentsColumnLabel: 'Appointments',
};

function patient(overrides: Partial<CaseloadEntry> & { patientId: string }): CaseloadEntry {
  return {
    fullName: `Patient ${overrides.patientId}`,
    accountStatus: 'approved',
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

function renderCaseload(items: readonly CaseloadEntry[], counts?: { total: number; active: number }) {
  render(
    <CaseloadView
      strings={STRINGS}
      recordHrefBase="/en/account/patient-record"
      client={session}
      fetchPage={vi.fn().mockResolvedValue(jsonResponse({ items, counts }))}
      listClinicians={vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ items: [{ id: 'c1', displayName: 'Dr Ada', role: 'sub', active: true }] }),
        )}
      assignPatient={vi.fn()}
      setPatientActive={vi.fn()}
    />,
  );
}

/** The row for a named patient, so assertions are scoped to it rather than the page. */
async function rowFor(name: string): Promise<HTMLElement> {
  const cell = await screen.findByText(name);
  const row = cell.closest('tr');
  if (!row) {
    throw new Error(`no row for ${name}`);
  }
  return row;
}

describe('which clinician holds which patient', () => {
  it('names the assigned clinician on the patient\'s own row', async () => {
    renderCaseload([
      patient({ patientId: 'p1', fullName: 'Alex Kim', assignedClinicianId: 'c1', assignedClinicianName: 'Dr Ada' }),
    ]);
    expect(within(await rowFor('Alex Kim')).getByText('Dr Ada')).toBeDefined();
  });

  it('says "unassigned" rather than leaving the cell blank', async () => {
    // A blank cell in a clinician column reads as missing data. Nobody
    // holding this patient is a fact, and the view this exists to be says so.
    renderCaseload([patient({ patientId: 'p2', fullName: 'Sam Lee' })]);
    expect(within(await rowFor('Sam Lee')).getByText('Unassigned')).toBeDefined();
  });

  it('keeps each patient\'s clinician on their own row when several are listed', async () => {
    renderCaseload([
      patient({ patientId: 'p1', fullName: 'Alex Kim', assignedClinicianId: 'c1', assignedClinicianName: 'Dr Ada' }),
      patient({ patientId: 'p2', fullName: 'Sam Lee' }),
      patient({ patientId: 'p3', fullName: 'Jo Ray', assignedClinicianId: 'c2', assignedClinicianName: 'Dr Bell' }),
    ]);
    expect(within(await rowFor('Alex Kim')).queryByText('Dr Bell')).toBeNull();
    expect(within(await rowFor('Jo Ray')).getByText('Dr Bell')).toBeDefined();
    expect(within(await rowFor('Sam Lee')).getByText('Unassigned')).toBeDefined();
  });

  it('links a patient name to their own record', async () => {
    renderCaseload([patient({ patientId: 'p1', fullName: 'Alex Kim' })]);
    // The fetch resolves after the first paint, so the row has to be waited
    // for before anything inside it can be queried.
    const link = await screen.findByRole('link', { name: 'Alex Kim' });
    expect(link.getAttribute('href')).toBe('/en/account/patient-record?id=p1');
  });
});

describe('status', () => {
  it('renders each status as its own badge, so the column reads as colour before it reads as text', async () => {
    renderCaseload([
      patient({ patientId: 'p1', fullName: 'Alex Kim', accountStatus: 'approved' }),
      patient({ patientId: 'p2', fullName: 'Sam Lee', accountStatus: 'pending' }),
      patient({ patientId: 'p3', fullName: 'Jo Ray', accountStatus: 'suspended' }),
    ]);
    const badge = async (name: string, label: string) =>
      within(await rowFor(name)).getByText(label);

    expect((await badge('Alex Kim', 'Approved')).className).toContain(
      'ndn-caseload-status--approved',
    );
    expect((await badge('Sam Lee', 'Pending')).className).toContain(
      'ndn-caseload-status--pending',
    );
    expect((await badge('Jo Ray', 'Suspended')).className).toContain(
      'ndn-caseload-status--suspended',
    );
  });
});

describe('the counts above the table', () => {
  it('shows total and active when the first page carries them', async () => {
    renderCaseload([patient({ patientId: 'p1', fullName: 'Alex Kim' })], { total: 12, active: 9 });
    expect(await screen.findByText('Total patients')).toBeDefined();
    expect(screen.getByText('12')).toBeDefined();
    expect(screen.getByText('9')).toBeDefined();
  });

  it('omits them entirely rather than rendering zeroes when the page has none', async () => {
    renderCaseload([patient({ patientId: 'p1', fullName: 'Alex Kim' })]);
    await screen.findByText('Alex Kim');
    expect(screen.queryByText('Total patients')).toBeNull();
  });
});

describe('states that are not a table', () => {
  it('reports a refusal as an ordinary outcome, not an error', async () => {
    render(
      <CaseloadView
        strings={STRINGS}
        recordHrefBase="/en/account/patient-record"
        client={session}
        fetchPage={vi.fn().mockResolvedValue(jsonResponse({}, 403))}
        listClinicians={vi.fn().mockResolvedValue(jsonResponse({ items: [] }))}
      />,
    );
    expect(await screen.findByText('No access.')).toBeDefined();
  });

  it('says the caseload is empty rather than rendering a headed table with no rows', async () => {
    renderCaseload([]);
    await waitFor(() => {
      expect(screen.getByText('No patients yet.')).toBeDefined();
    });
    expect(screen.queryByRole('table')).toBeNull();
  });
});
