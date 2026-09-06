// @vitest-environment jsdom
//
// 2026-09-06: the dashboard's month calendar.
//
// The behaviours worth pinning are the ones a screenshot cannot show: which
// endpoint each role is sent to, that a patient's month change costs no
// second request while a clinician's must, that a patient never sees an
// unapproved slot, and that scrolling back a month actually reaches the past
// — which is the whole point of the view.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentCalendar,
  calendarSourcesFor,
  visibleForPatient,
} from './AppointmentCalendar.js';
import type { CalendarAppointment } from './AppointmentCalendar.js';

afterEach(cleanup);

// Local construction throughout, so the suite passes in any timezone — see
// `calendar-grid.test.ts` for the same discipline and why it matters here.
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month, day, hour, minute);
}

/**
 * The window headings the grid shows, spelled out rather than rebuilt with
 * `Intl` here — a test that recomputes the string it is checking proves only
 * that the code agrees with itself.
 *
 * 15 September 2026 is a Tuesday, and the window is centred on the day
 * itself — 17 days either side — so it runs Saturday 29 August to Friday
 * 2 October. The columns therefore run Sat…Fri: that is the trade
 * `calendar-grid.ts` makes to put today in the middle square on every
 * weekday rather than only on a Thursday. One press back moves it two weeks,
 * which keeps those columns.
 */
const DEFAULT_WINDOW = 'August 29 – October 2, 2026';
const EARLIER_WINDOW = 'August 15 – September 18, 2026';

/** 15 September 2026, midday. Stable identity — `useNow` requires it. */
const NOW = local(2026, 8, 15, 12, 0);
const now = (): Date => NOW;

function appointment(
  date: Date,
  status: CalendarAppointment['appointment_status'] = 'scheduled',
): CalendarAppointment {
  return {
    patientId: 'patient-1',
    scheduledAt: date.toISOString(),
    durationMinutes: 45,
    appointment_status: status,
  };
}

const STRINGS = {
  heading: 'My calendar',
  loadingLabel: 'Loading your calendar…',
  forbiddenLabel: 'No calendar for you.',
  errorLabel: 'Calendar failed.',
  previousWeeksLabel: 'Previous two weeks',
  nextWeeksLabel: 'Next two weeks',
  todayLabel: 'Today',
  gridCaption: 'Appointments by day.',
  todayMarker: 'Today',
  noAppointmentsOnDay: 'No appointments on this day.',
  emptyWindow: 'No appointments in this period.',
  durationLabel: 'Duration:',
  minutesSuffix: 'minutes',
  statusLabel: 'Status:',
  joinCallLabel: 'Join call',
  approveLabel: 'Approve',
  declineLabel: 'Decline',
  completeLabel: 'Mark as attended',
  noShowLabel: 'Mark as no-show',
  decidingLabel: 'Saving…',
  decideFailedLabel: 'That could not be saved.',
  statusLabels: {
    scheduled: 'Confirmed',
    'pending-approval': 'Waiting for approval',
    completed: 'Attended',
    cancelled: 'Cancelled',
    'no-show': 'Did not attend',
  },
};

// `null`, not `undefined`, for "no access token": a default parameter is
// applied when the argument *is* `undefined`, so `sessionFor('patient',
// undefined)` would have handed back the default token and quietly tested
// something else entirely.
function sessionFor(role: string | undefined, accessToken: string | null = 'token') {
  return {
    resolve: () => Promise.resolve({ status: 'signed-in', session: { viewerRole: role } }),
    authorization: () => Promise.resolve(accessToken ?? undefined),
    complete: () => Promise.resolve({ status: 'signed-out' }),
    signOut: () => Promise.resolve(undefined),
  } as never;
}

function jsonResponse(items: readonly CalendarAppointment[], status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ items }),
  } as unknown as Response;
}

describe('calendarSourcesFor', () => {
  it('sends a patient to their own history and a clinician to the ranged calendar', () => {
    expect(calendarSourcesFor('patient')).toEqual(['patient']);
    expect(calendarSourcesFor('principal-clinician')).toEqual(['clinician']);
    expect(calendarSourcesFor('sub-clinician')).toEqual(['clinician']);
  });

  it('gives helpdesk and visitor no calendar at all — the owner\'s own exclusion', () => {
    expect(calendarSourcesFor('helpdesk')).toEqual([]);
    expect(calendarSourcesFor('visitor')).toEqual([]);
  });

  it('tries both when the token cannot be read, rather than hiding on a shrug', () => {
    expect(calendarSourcesFor(undefined)).toEqual(['patient', 'clinician']);
  });
});

describe('visibleForPatient', () => {
  const all = [
    appointment(local(2026, 8, 1), 'scheduled'),
    appointment(local(2026, 8, 2), 'pending-approval'),
    appointment(local(2026, 8, 3), 'cancelled'),
    appointment(local(2026, 8, 4), 'completed'),
    appointment(local(2026, 8, 5), 'no-show'),
  ];

  it('hides what was never confirmed and what never happened', () => {
    const statuses = visibleForPatient(all).map((item) => item.appointment_status);
    expect(statuses).not.toContain('pending-approval');
    expect(statuses).not.toContain('cancelled');
  });

  it('keeps attendance history, which is what a past month is for', () => {
    const statuses = visibleForPatient(all).map((item) => item.appointment_status);
    expect(statuses).toEqual(['scheduled', 'completed', 'no-show']);
  });
});

describe('who gets a calendar', () => {
  it('renders nothing at all for helpdesk', async () => {
    const fetchPatient = vi.fn();
    const { container } = render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('helpdesk')}
        fetchPatientAppointments={fetchPatient}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
    expect(fetchPatient).not.toHaveBeenCalled();
  });

  it('renders nothing for a visitor', async () => {
    const { container } = render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('visitor')}
        fetchPatientAppointments={vi.fn()}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.textContent).toBe('');
    });
  });
});

describe('a patient', () => {
  const items = [
    appointment(local(2026, 8, 15, 9, 0)),
    appointment(local(2026, 8, 15, 14, 30)),
    appointment(local(2026, 7, 20, 10, 0), 'completed'),
    appointment(local(2026, 8, 22, 10, 0), 'pending-approval'),
  ];

  function renderPatient(fetchPatient = vi.fn().mockResolvedValue(jsonResponse(items))) {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient')}
        fetchPatientAppointments={fetchPatient}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    return fetchPatient;
  }

  it('opens on a window centred on today, with today selected', async () => {
    renderPatient();
    expect(await screen.findByText(DEFAULT_WINDOW)).toBeDefined();
    // Today has two appointments, so the panel below the grid lists them.
    expect(await screen.findByRole('heading', { name: /September 15, 2026/ })).toBeDefined();
  });

  it('shows a confirmed appointment with its duration, status and join control', async () => {
    renderPatient();
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.getAllByText(/45 minutes/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Confirmed/).length).toBeGreaterThan(0);
  });

  it('never shows an unapproved slot, whatever the API returns', async () => {
    renderPatient();
    await screen.findByText(DEFAULT_WINDOW);
    expect(screen.queryByText('Waiting for approval')).toBeNull();
    // 22 September is `pending-approval`, so its square must not be a
    // pressable day at all.
    expect(screen.queryByRole('button', { name: /September 22, 2026/ })).toBeNull();
  });

  it('scrolls back and finds what happened there', async () => {
    renderPatient();
    await screen.findByText(DEFAULT_WINDOW);

    (await screen.findByRole('button', { name: 'Previous two weeks' })).click();

    expect(await screen.findByText(EARLIER_WINDOW)).toBeDefined();
    const august20 = await screen.findByRole('button', { name: /August 20, 2026/ });
    august20.click();
    expect(await screen.findByRole('heading', { name: /August 20, 2026/ })).toBeDefined();
    expect(screen.getAllByText(/Attended/).length).toBeGreaterThan(0);
  });

  it('costs no second request to move the window — the whole history arrived at once', async () => {
    const fetchPatient = renderPatient();
    await screen.findByText(DEFAULT_WINDOW);
    expect(fetchPatient).toHaveBeenCalledTimes(1);

    (await screen.findByRole('button', { name: 'Previous two weeks' })).click();
    await screen.findByText(EARLIER_WINDOW);
    (await screen.findByRole('button', { name: 'Next two weeks' })).click();
    await screen.findByText(DEFAULT_WINDOW);

    expect(fetchPatient).toHaveBeenCalledTimes(1);
  });

  it('re-centres on today from the Today control', async () => {
    renderPatient();
    await screen.findByText(DEFAULT_WINDOW);
    (await screen.findByRole('button', { name: 'Previous two weeks' })).click();
    await screen.findByText(EARLIER_WINDOW);

    (await screen.findByRole('button', { name: 'Today' })).click();
    expect(await screen.findByText(DEFAULT_WINDOW)).toBeDefined();
  });

  it('says so for a month with nothing in it', async () => {
    renderPatient(vi.fn().mockResolvedValue(jsonResponse([])));
    expect(await screen.findByText('No appointments in this period.')).toBeDefined();
  });
});

describe('a clinician', () => {
  it('fetches a range covering the whole visible grid, and a new one per move', async () => {
    const fetchClinician = vi
      .fn()
      .mockResolvedValue(jsonResponse([appointment(local(2026, 8, 15, 9, 0))]));
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('sub-clinician')}
        fetchPatientAppointments={vi.fn()}
        fetchClinicianCalendar={fetchClinician}
      />,
    );
    await screen.findByText(DEFAULT_WINDOW);
    expect(fetchClinician).toHaveBeenCalledTimes(1);

    const [firstFrom] = fetchClinician.mock.calls[0] as [string, string, string];
    // The grid's first square is in August — a range clipped to September
    // would leave that row permanently empty.
    expect(new Date(firstFrom).getTime()).toBeLessThan(local(2026, 8, 1).getTime());

    (await screen.findByRole('button', { name: 'Previous two weeks' })).click();
    await screen.findByText(EARLIER_WINDOW);

    await waitFor(() => {
      expect(fetchClinician).toHaveBeenCalledTimes(2);
    });
    const [secondFrom] = fetchClinician.mock.calls[1] as [string, string, string];
    expect(new Date(secondFrom).getTime()).toBeLessThan(new Date(firstFrom).getTime());
  });

  it('shows an unapproved slot, which a patient is not shown', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('principal-clinician')}
        fetchPatientAppointments={vi.fn()}
        fetchClinicianCalendar={vi
          .fn()
          .mockResolvedValue(
            jsonResponse([appointment(local(2026, 8, 15, 9, 0), 'pending-approval')]),
          )}
      />,
    );
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.getAllByText(/Waiting for approval/).length).toBeGreaterThan(0);
    // Nothing to join until it is confirmed — `ws-join.ts` would refuse it.
    expect(screen.queryByRole('link', { name: 'Join call' })).toBeNull();
  });
});

describe('a token this bundle cannot read', () => {
  it('falls back to the clinician endpoint when the patient one refuses', async () => {
    const fetchPatient = vi.fn().mockResolvedValue(jsonResponse([], 403));
    const fetchClinician = vi
      .fn()
      .mockResolvedValue(jsonResponse([appointment(local(2026, 8, 15, 9, 0))]));
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor(undefined)}
        fetchPatientAppointments={fetchPatient}
        fetchClinicianCalendar={fetchClinician}
      />,
    );
    // Hiding the calendar from someone entitled to it is the worse failure —
    // so an unreadable claim costs a wasted request, not a blank dashboard.
    expect(await screen.findByRole('heading', { name: /September 15, 2026/ })).toBeDefined();
    expect(fetchPatient).toHaveBeenCalled();
    expect(fetchClinician).toHaveBeenCalled();
  });

  it('reports a refusal when every source refuses', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor(undefined)}
        fetchPatientAppointments={vi.fn().mockResolvedValue(jsonResponse([], 403))}
        fetchClinicianCalendar={vi.fn().mockResolvedValue(jsonResponse([], 403))}
      />,
    );
    expect(await screen.findByText('No calendar for you.')).toBeDefined();
  });
});

describe('when the calendar cannot be loaded', () => {
  it('reports an error rather than an empty month', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient')}
        fetchPatientAppointments={vi.fn().mockRejectedValue(new Error('network'))}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    expect(await screen.findByText('Calendar failed.')).toBeDefined();
  });

  it('is forbidden, not broken, with no access token', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient', null)}
        fetchPatientAppointments={vi.fn()}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    expect(await screen.findByText('No calendar for you.')).toBeDefined();
  });
});

// 2026-09-06, found on the production run rather than by any local suite:
// `account-a11y.setup.ts` waits for `getByRole('status')` to reach zero
// before capturing the signed-in storage state — its proxy for "the page has
// finished loading". This component's day-announcement region is present for
// the life of the page, so carrying `role="status"` pinned that count at 1
// forever, the setup timed out, and all 28 authenticated axe scans were
// skipped. `aria-live="polite"` announces identically without claiming the
// role, and this holds it there.
describe('the loading contract the authenticated a11y gate depends on', () => {
  it('leaves no role="status" element behind once the calendar is ready', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient')}
        fetchPatientAppointments={vi
          .fn()
          .mockResolvedValue(jsonResponse([appointment(local(2026, 8, 15, 9, 0))]))}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    await screen.findByText(DEFAULT_WINDOW);
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });

  it('still announces the selected day to assistive tech', async () => {
    const { container } = render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient')}
        fetchPatientAppointments={vi
          .fn()
          .mockResolvedValue(jsonResponse([appointment(local(2026, 8, 15, 9, 0))]))}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    await screen.findByText(DEFAULT_WINDOW);
    // The region is gone as a *role*, not as a live region — dropping the
    // announcement would have been the wrong fix for the wrong problem.
    const live = container.querySelectorAll('[aria-live="polite"]');
    expect(live.length).toBeGreaterThan(0);
    expect([...live].some((el) => el.textContent?.includes('September 15, 2026'))).toBe(true);
  });

  it('does use role="status" while it is genuinely still loading', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient')}
        fetchPatientAppointments={() => new Promise(() => {})}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
    // The setup's assumption is sound; it was this component that broke it.
    expect(await screen.findByRole('status')).toBeDefined();
  });
});

// 2026-09-06: `account/calendar` was deleted at the owner's word ("remove
// those two pages entirely"), and these four controls came here with it.
//
// Marking attendance had **no other home in the UI at all** —
// `PatientRecordPanel` carries approve/decline, nothing carried
// complete/no-show — and `appointment.ts` is explicit that without those
// routes `appointment_status` never reaches `completed`, leaving every
// "appointments so far" figure reading zero. Deleting the page without
// moving this would have broken those counts silently, which is what these
// tests exist to stop happening again.
describe('the decisions inherited from the deleted calendar page', () => {
  function renderClinician(
    entry: CalendarAppointment,
    decideAppointment = vi.fn().mockResolvedValue(jsonResponse([])),
    role = 'principal-clinician',
  ) {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor(role)}
        fetchPatientAppointments={vi.fn()}
        fetchClinicianCalendar={vi.fn().mockResolvedValue(jsonResponse([entry]))}
        decideAppointment={decideAppointment}
      />,
    );
    return decideAppointment;
  }

  it('offers attendance on a confirmed slot, which nothing else in the UI does', async () => {
    renderClinician(appointment(local(2026, 8, 15, 9, 0)));
    expect(await screen.findByRole('button', { name: 'Mark as attended' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Mark as no-show' })).toBeDefined();
  });

  it('posts the decision for the right appointment', async () => {
    const entry = appointment(local(2026, 8, 15, 9, 0));
    const decide = renderClinician(entry);
    (await screen.findByRole('button', { name: 'Mark as attended' })).click();
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith('token', entry, 'complete');
    });
  });

  it('offers approve and decline on a pending slot, to the principal', async () => {
    renderClinician(appointment(local(2026, 8, 15, 9, 0), 'pending-approval'));
    expect(await screen.findByRole('button', { name: 'Approve' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Decline' })).toBeDefined();
    // Nothing to join until it is confirmed — `ws-join.ts` would refuse it.
    expect(screen.queryByRole('link', { name: 'Join call' })).toBeNull();
  });

  it('hides approve and decline from a sub-clinician rather than offering then refusing', async () => {
    renderClinician(
      appointment(local(2026, 8, 15, 9, 0), 'pending-approval'),
      vi.fn(),
      'sub-clinician',
    );
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('still offers attendance to a sub-clinician — that rides Appointments: update', async () => {
    renderClinician(appointment(local(2026, 8, 15, 9, 0)), vi.fn(), 'sub-clinician');
    expect(await screen.findByRole('button', { name: 'Mark as attended' })).toBeDefined();
  });

  it('offers a patient none of them, on their own calendar', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient')}
        fetchPatientAppointments={vi
          .fn()
          .mockResolvedValue(jsonResponse([appointment(local(2026, 8, 15, 9, 0))]))}
        fetchClinicianCalendar={vi.fn()}
        decideAppointment={vi.fn()}
      />,
    );
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.queryByRole('button', { name: 'Mark as attended' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('reports a refusal on the row it belongs to rather than failing silently', async () => {
    renderClinician(
      appointment(local(2026, 8, 15, 9, 0)),
      vi.fn().mockResolvedValue(jsonResponse([], 403)),
    );
    (await screen.findByRole('button', { name: 'Mark as attended' })).click();
    // A 403 (not yours) and a 409 (already decided) land here together: both
    // mean "this row is not yours to change now".
    expect((await screen.findByRole('alert')).textContent).toContain('That could not be saved.');
  });
});
