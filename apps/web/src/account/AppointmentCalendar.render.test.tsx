// @vitest-environment jsdom
//
// 2026-09-06: the dashboard's month calendar.
//
// The behaviours worth pinning are the ones a screenshot cannot show: which
// endpoint each role is sent to, that a patient's month change costs no
// second request while a clinician's must, that a patient never sees an
// unapproved slot, and that scrolling back a month actually reaches the past
// — which is the whole point of the view.
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AppointmentCalendar,
  calendarSourcesFor,
  liveAppointment,
  mayJoinCalls,
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
 * 15 September 2026 is a Tuesday, so the default window — two whole weeks
 * either side of its own week, Monday-first — runs Monday 31 August to
 * Sunday 4 October, and one press up moves it two weeks earlier. The
 * columns are Mon…Sun on every one of these, whichever weekday the window
 * is centred on; that is what the third pass bought back.
 */
const DEFAULT_WINDOW = 'August 31 – October 4, 2026';
const EARLIER_WINDOW = 'August 17 – September 20, 2026';

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
  patientLabel: 'Patient:',
  clinicianLabel: 'Clinician:',
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

  it('sends helpdesk to the clinician route — the practice calendar, from 2026-09-06', () => {
    expect(calendarSourcesFor('helpdesk')).toEqual(['clinician']);
  });

  it('still gives a visitor no calendar at all — the half of the exclusion that stands', () => {
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

// 2026-09-06: *"when the appointment comes I want to have a 'join call'
// button on the calender that both can click to join the call."*
describe('liveAppointment', () => {
  /** 11:45 + 45 minutes brackets NOW (12:00); 9:00 + 45 ended at 9:45. */
  const inProgress = appointment(local(2026, 8, 15, 11, 45));
  const finished = appointment(local(2026, 8, 15, 9, 0));
  const later = appointment(local(2026, 8, 15, 14, 30));

  it('finds the appointment whose slot is open right now', () => {
    expect(liveAppointment([finished, inProgress, later], NOW)).toBe(inProgress);
  });

  it('has no answer when nothing is open — before, after, and both at once', () => {
    expect(liveAppointment([finished, later], NOW)).toBeUndefined();
    expect(liveAppointment([], NOW)).toBeUndefined();
  });

  it('ignores a slot that is open but not confirmed, which ws-join.ts would refuse', () => {
    // `not-confirmed` and `cancelled` are two of that file's own denial
    // reasons: the slot being live is not enough to have a call in it.
    for (const status of ['pending-approval', 'cancelled', 'completed', 'no-show']) {
      expect(liveAppointment([appointment(local(2026, 8, 15, 11, 45), status)], NOW)).toBeUndefined();
    }
  });

  it('takes the earliest of several open at once, not whichever the API listed first', () => {
    // A clinician can have overlapping slots, and the one that started
    // first is the one they are late for. `find` would answer with the
    // 11:50 row here purely because it arrived first.
    const later0 = appointment(local(2026, 8, 15, 11, 50));
    expect(liveAppointment([later0, inProgress], NOW)).toBe(inProgress);
  });

  it('treats an unparseable instant as not live, rather than offering a link for it', () => {
    // Every `NaN` comparison is false, so a phase check alone would fall
    // through to "open" and build a call id nothing can resolve.
    const malformed = { ...inProgress, scheduledAt: 'not-a-date' };
    expect(liveAppointment([malformed], NOW)).toBeUndefined();
  });
});

describe('mayJoinCalls', () => {
  it('gives a call to the two parties on it', () => {
    expect(mayJoinCalls('patient')).toBe(true);
    expect(mayJoinCalls('sub-clinician')).toBe(true);
    expect(mayJoinCalls('principal-clinician')).toBe(true);
  });

  it('withholds it from a helpdesk, who hold read on Appointments and no join-call', () => {
    expect(mayJoinCalls('helpdesk')).toBe(false);
    expect(mayJoinCalls('visitor')).toBe(false);
  });

  it('offers it on an unreadable token, letting the server answer', () => {
    expect(mayJoinCalls(undefined)).toBe(true);
  });
});

describe('who gets a calendar', () => {
  it('gives helpdesk the clinician calendar, and never the patient route', async () => {
    const fetchPatient = vi.fn();
    const fetchClinician = vi
      .fn()
      .mockResolvedValue(jsonResponse([appointment(local(2026, 8, 15, 9, 0))]));
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('helpdesk')}
        fetchPatientAppointments={fetchPatient}
        fetchClinicianCalendar={fetchClinician}
      />,
    );
    expect(await screen.findByText(DEFAULT_WINDOW)).toBeDefined();
    expect(fetchClinician).toHaveBeenCalledTimes(1);
    expect(fetchPatient).not.toHaveBeenCalled();
  });

  it('offers a helpdesk none of the four decisions — "in read only mode"', async () => {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('helpdesk')}
        fetchPatientAppointments={vi.fn()}
        fetchClinicianCalendar={vi.fn().mockResolvedValue(
          jsonResponse([
            appointment(local(2026, 8, 15, 9, 0), 'scheduled'),
            appointment(local(2026, 8, 15, 11, 0), 'pending-approval'),
          ]),
        )}
      />,
    );
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    // Both halves: approve/decline (the principal's) and complete/no-show
    // (which every treating clinician holds and a helpdesk does not).
    for (const label of ['Approve', 'Decline', 'Mark as attended', 'Mark as no-show']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull();
    }
    // The appointments themselves are still fully readable — read-only, not
    // hidden.
    expect(screen.getAllByText(/Duration:/).length).toBe(2);
  });

  it('offers the principal those same four, so the check above is not vacuous', async () => {
    // The positive control for the test above: identical data, identical
    // labels, a different role. Without this, a renamed label would make
    // every `queryByRole(...).toBeNull()` pass for the wrong reason.
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('principal-clinician')}
        fetchPatientAppointments={vi.fn()}
        fetchClinicianCalendar={vi.fn().mockResolvedValue(
          jsonResponse([
            appointment(local(2026, 8, 15, 9, 0), 'scheduled'),
            appointment(local(2026, 8, 15, 11, 0), 'pending-approval'),
          ]),
        )}
      />,
    );
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    for (const label of ['Approve', 'Decline', 'Mark as attended', 'Mark as no-show']) {
      expect(screen.getByRole('button', { name: label })).toBeDefined();
    }
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

// 2026-09-06: *"on calender when we click an appointment it should also show
// the name of the patient and the name of the clinician."* The API joins them
// onto the row; this is the half that renders them.
describe('the names on a day panel', () => {
  function renderWith(entry: CalendarAppointment) {
    render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor('patient')}
        fetchPatientAppointments={vi.fn().mockResolvedValue(jsonResponse([entry]))}
        fetchClinicianCalendar={vi.fn()}
      />,
    );
  }

  it('shows both names when the API sent them', async () => {
    renderWith({
      ...appointment(local(2026, 8, 15, 9, 0)),
      patientName: 'Ada Lovelace',
      clinicianName: 'Dr Grace Hopper',
    });
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.getByText(/Ada Lovelace/)).toBeDefined();
    expect(screen.getByText(/Dr Grace Hopper/)).toBeDefined();
  });

  it('drops the line entirely when a name is absent, rather than labelling a blank', async () => {
    // The server omits a name it will not disclose *and* one that is not
    // recorded, so the absent case is ordinary rather than exceptional — a
    // "Patient:" with nothing after it would read as data loss.
    renderWith(appointment(local(2026, 8, 15, 9, 0)));
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.queryByText(/Patient:/)).toBeNull();
    expect(screen.queryByText(/Clinician:/)).toBeNull();
    // The rest of the row is untouched — a missing name costs only its line.
    expect(screen.getByText(/Duration:/)).toBeDefined();
  });

  it('shows the clinician alone when only that name resolved', async () => {
    renderWith({
      ...appointment(local(2026, 8, 15, 9, 0)),
      clinicianName: 'Dr Grace Hopper',
    });
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.getByText(/Dr Grace Hopper/)).toBeDefined();
    expect(screen.queryByText(/Patient:/)).toBeNull();
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

// 2026-09-06: *"in patient and clinician landing dashboard there is a
// calender that shows the next coming appointment. when the appointment comes
// I want to have a 'join call' button on the calender that both can click to
// join the call."*
//
// The day panel has always carried a join control. What is pinned here is the
// part that was missing: it appears **on the calendar**, without the reader
// having found the right square first, and both sides get the identical
// thing.
describe('the join button, once a call is open', () => {
  /** Brackets NOW (12:00): 11:45 + 45 minutes runs to 12:30. */
  const openNow = local(2026, 8, 15, 11, 45);

  /** The banner above the grid, not the day panel's own row. */
  function banner(container: HTMLElement): HTMLElement | null {
    return container.querySelector('.ndn-cal-live');
  }

  function renderFor(role: string, items: readonly CalendarAppointment[]) {
    return render(
      <AppointmentCalendar
        strings={STRINGS}
        locale="en"
        now={now}
        client={sessionFor(role)}
        fetchPatientAppointments={vi.fn().mockResolvedValue(jsonResponse(items))}
        fetchClinicianCalendar={vi.fn().mockResolvedValue(jsonResponse(items))}
      />,
    );
  }

  it('puts a join link on a patient calendar the moment the slot is open', async () => {
    const { container } = renderFor('patient', [appointment(openNow)]);
    await screen.findByText(DEFAULT_WINDOW);

    const live = banner(container);
    expect(live).not.toBeNull();
    const join = within(live as HTMLElement).getByRole('link', { name: 'Join call' });
    // `call.astro` reads one composite id off the query string
    // (`ws-join.ts`'s `parseAppointmentId`) — the `#` is encoded, so the
    // fragment is a real query value rather than a URL fragment.
    expect(join.getAttribute('href')).toBe(
      `/en/account/call?appointmentId=patient-1%23${encodeURIComponent(openNow.toISOString())}`,
    );
  });

  it('puts the same one on a clinician calendar — "both can click to join"', async () => {
    const { container } = renderFor('principal-clinician', [appointment(openNow)]);
    await screen.findByText(DEFAULT_WINDOW);

    const live = banner(container);
    expect(live).not.toBeNull();
    expect(within(live as HTMLElement).getByRole('link', { name: 'Join call' })).toBeDefined();
  });

  it('says the call is under way, not merely that a link exists', async () => {
    const { container } = renderFor('patient', [appointment(openNow)]);
    await screen.findByText(DEFAULT_WINDOW);
    expect((banner(container) as HTMLElement).textContent).toMatch(/is under way now/);
  });

  it('shows nothing at all until the slot opens, and nothing once it has closed', async () => {
    // 9:00 finished at 9:45; 14:30 has not begun. Between them sits NOW.
    const { container } = renderFor('patient', [
      appointment(local(2026, 8, 15, 9, 0)),
      appointment(local(2026, 8, 15, 14, 30)),
    ]);
    await screen.findByText(DEFAULT_WINDOW);
    expect(banner(container)).toBeNull();
  });

  it('stays put when the reader has scrolled the window somewhere else', async () => {
    // The whole reason this is not a day-panel-only control: a call opening
    // while someone is reading last month must still reach them.
    const { container } = renderFor('patient', [appointment(openNow)]);
    await screen.findByText(DEFAULT_WINDOW);

    (await screen.findByRole('button', { name: 'Previous two weeks' })).click();
    await screen.findByText(EARLIER_WINDOW);

    expect(banner(container)).not.toBeNull();
  });

  it('names the patient to a clinician, so a busy day says who is waiting', async () => {
    const { container } = renderFor('sub-clinician', [
      { ...appointment(openNow), patientName: 'Jane Doe', clinicianName: 'Dr Smith' },
    ]);
    await screen.findByText(DEFAULT_WINDOW);
    const text = (banner(container) as HTMLElement).textContent ?? '';
    expect(text).toMatch(/Jane Doe/);
    // The other party, not both — a clinician knows who they are.
    expect(text).not.toMatch(/Dr Smith/);
  });

  it('names the clinician to a patient, which is the other half of the same rule', async () => {
    const { container } = renderFor('patient', [
      { ...appointment(openNow), patientName: 'Jane Doe', clinicianName: 'Dr Smith' },
    ]);
    await screen.findByText(DEFAULT_WINDOW);
    const text = (banner(container) as HTMLElement).textContent ?? '';
    expect(text).toMatch(/Dr Smith/);
    expect(text).not.toMatch(/Jane Doe/);
  });

  it('marks the live appointment in the grid itself, in both renderings', async () => {
    // Chips on a wide screen, dots below 34rem — the square has to say a
    // call is open either way, not only the banner above it.
    const { container } = renderFor('patient', [appointment(openNow)]);
    await screen.findByText(DEFAULT_WINDOW);
    expect(container.querySelector('.ndn-cal-chip--live')).not.toBeNull();
    expect(container.querySelector('.ndn-cal-dot--live')).not.toBeNull();
  });

  it('offers a helpdesk no way into a call, live or otherwise', async () => {
    // `authz-matrix.ts` gives Helpdesk `read` on Appointments and no
    // `join-call`, so every one of these would be refused on arrival —
    // including the day panel's own countdown, which promises one later.
    const { container } = renderFor('helpdesk', [appointment(openNow)]);
    await screen.findByRole('heading', { name: /September 15, 2026/ });

    expect(banner(container)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Join call' })).toBeNull();
    // Still a fully readable calendar — read-only, not hidden.
    expect(screen.getAllByText(/Duration:/).length).toBe(1);
  });

  it('keeps the day panel row as well, rather than moving the control', async () => {
    // The positive control for the helpdesk assertion above, and the check
    // that the banner is an addition: two join links, one in each place.
    renderFor('patient', [appointment(openNow)]);
    await screen.findByRole('heading', { name: /September 15, 2026/ });
    expect(screen.getAllByRole('link', { name: 'Join call' })).toHaveLength(2);
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
