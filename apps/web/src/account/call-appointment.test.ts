// 2026-09-07: role resolution, and the bug it exists to make impossible.
//
// The old `resolveRole` (in `VideoCall.tsx`) was one line —
// `response.ok ? 'clinician' : 'patient'` — and that line meant a 500, a
// 502 or a dropped connection labelled a clinician a patient. Both parties
// then believed they were the offerer, both sent an offer, and each
// rejected the other's: two people on "Connecting…" behind a black frame
// with nothing on screen to explain it. Half of this file is about the
// difference between "we asked and got an answer" and "we asked and did
// not", because collapsing the two is the whole of that fault.
//
// Pure-ish by construction: `fetch` is the only thing stubbed, and every
// retry's sleep is injected so a test costs no real time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { calendarWindow, findAppointment, resolveCallContext } from './call-appointment.js';

const SCHEDULED_AT = new Date('2026-09-01T10:00:00.000Z');
const PATIENT_ID = 'pat-1';

/** No real time passes for a retry. */
const noSleep = () => Promise.resolve();

function resolve() {
  return resolveCallContext({
    accessToken: 'a.b.c',
    patientId: PATIENT_ID,
    scheduledAt: SCHEDULED_AT,
    sleep: noSleep,
  });
}

interface Reply {
  readonly ok?: boolean;
  readonly status?: number;
  readonly items?: unknown;
  /** Throws instead of answering — a network that is simply not there. */
  readonly throws?: boolean;
}

/** Steers each of the two probes by URL. */
function stubFetch(replies: {
  clinician: Reply | Reply[];
  patient?: Reply | Reply[];
}): ReturnType<typeof vi.fn> {
  const queues = new Map<string, Reply[]>([
    ['clinician', Array.isArray(replies.clinician) ? [...replies.clinician] : [replies.clinician]],
    [
      'patient',
      Array.isArray(replies.patient)
        ? [...(replies.patient ?? [])]
        : [replies.patient ?? { status: 200, items: [] }],
    ],
  ]);
  const fetchMock = vi.fn((input: unknown) => {
    const which = String(input).includes('/clinicians/me/calendar') ? 'clinician' : 'patient';
    const queue = queues.get(which) as Reply[];
    // The last reply repeats, so a test can say "it 500s" once rather than
    // three times.
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) as Reply;
    if (reply.throws) {
      return Promise.reject(new Error('network is down'));
    }
    const status = reply.status ?? 200;
    return Promise.resolve({
      ok: reply.ok ?? (status >= 200 && status < 300),
      status,
      json: () => Promise.resolve({ items: reply.items ?? [] }),
    } as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const appointmentRow = (overrides: Record<string, unknown> = {}) => ({
  patientId: PATIENT_ID,
  scheduledAt: SCHEDULED_AT.toISOString(),
  durationMinutes: 45,
  appointment_status: 'scheduled',
  ...overrides,
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the role', () => {
  it('is clinician when the clinician calendar answers', async () => {
    stubFetch({ clinician: { status: 200, items: [appointmentRow()] } });
    await expect(resolve()).resolves.toMatchObject({ kind: 'resolved', role: 'clinician' });
  });

  it('is patient on a 403 — a refusal is a real answer about who the caller is', async () => {
    stubFetch({ clinician: { status: 403 }, patient: { status: 200, items: [appointmentRow()] } });
    await expect(resolve()).resolves.toMatchObject({ kind: 'resolved', role: 'patient' });
  });

  // **The fix.** Both of these used to resolve as `'patient'`.
  it('is not guessed when the calendar 500s — a clinician whose route is broken is not a patient', async () => {
    stubFetch({ clinician: { status: 500 } });
    await expect(resolve()).resolves.toEqual({ kind: 'error' });
  });

  it('is not guessed when the network is down either', async () => {
    stubFetch({ clinician: { throws: true } });
    await expect(resolve()).resolves.toEqual({ kind: 'error' });
  });

  it('never asks the patient route after an inconclusive clinician one', async () => {
    // Falling through to "patient" on an unanswered question is precisely
    // the mislabelling this file exists to prevent, so the second probe
    // must not even happen.
    const fetchMock = stubFetch({ clinician: { status: 503 } });
    await resolve();
    expect(fetchMock.mock.calls.every(([url]) => String(url).includes('/clinicians/'))).toBe(true);
  });

  it('retries a 5xx before giving up, since it may well be transient', async () => {
    const fetchMock = stubFetch({
      clinician: [{ status: 502 }, { status: 200, items: [appointmentRow()] }],
    });
    await expect(resolve()).resolves.toMatchObject({ kind: 'resolved', role: 'clinician' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 403 — there is nothing about it that a second ask improves', async () => {
    const fetchMock = stubFetch({ clinician: { status: 403 }, patient: { status: 200 } });
    await resolve();
    const clinicianCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes('/clinicians/'),
    );
    expect(clinicianCalls).toHaveLength(1);
  });

  it('is forbidden on a 401 — no identity at all is a different fact from "not this role"', async () => {
    stubFetch({ clinician: { status: 401 } });
    await expect(resolve()).resolves.toEqual({ kind: 'forbidden' });
  });
});

describe('the appointment', () => {
  it('comes back with the role when the caller is a clinician', async () => {
    stubFetch({ clinician: { status: 200, items: [appointmentRow({ durationMinutes: 15 })] } });
    await expect(resolve()).resolves.toMatchObject({
      appointment: { durationMinutes: 15, status: 'scheduled' },
    });
  });

  it('comes from the patient’s own list when the caller is a patient', async () => {
    stubFetch({
      clinician: { status: 403 },
      patient: { status: 200, items: [appointmentRow({ durationMinutes: 90 })] },
    });
    await expect(resolve()).resolves.toMatchObject({
      role: 'patient',
      appointment: { durationMinutes: 90 },
    });
  });

  // **The asymmetry that matters.** The role is settled by the clinician
  // probe's status alone; the appointment is a bonus. A patient whose own
  // list is down must still be able to hold their call — they simply get
  // the fallback limit and no expiry claim.
  it('is absent, and the role still patient, when the patient’s list fails', async () => {
    stubFetch({ clinician: { status: 403 }, patient: { status: 500 } });
    await expect(resolve()).resolves.toEqual({
      kind: 'resolved',
      role: 'patient',
      appointment: undefined,
    });
  });

  it('is absent when the row simply is not in the list', async () => {
    stubFetch({
      clinician: {
        status: 200,
        items: [appointmentRow({ scheduledAt: '2026-09-02T10:00:00.000Z' })],
      },
    });
    await expect(resolve()).resolves.toEqual({
      kind: 'resolved',
      role: 'clinician',
      appointment: undefined,
    });
  });

  it('does not fail the role over a body it cannot read', async () => {
    // A cosmetic API change must not cost anyone a call.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error('not json')),
        } as unknown as Response),
      ),
    );
    await expect(resolve()).resolves.toEqual({
      kind: 'resolved',
      role: 'clinician',
      appointment: undefined,
    });
  });
});

describe('findAppointment', () => {
  it('matches on the instant, not on the string', () => {
    // The id has been through `encodeURIComponent` and back, and
    // `…T10:00:00.000Z` and `…T10:00:00Z` are the same appointment however
    // unequal the two strings are.
    const found = findAppointment(
      [appointmentRow({ scheduledAt: '2026-09-01T10:00:00Z' })],
      PATIENT_ID,
      SCHEDULED_AT,
    );
    expect(found?.durationMinutes).toBe(45);
  });

  it('will not match another patient’s appointment at the same instant', () => {
    // A clinician's calendar carries every patient they see, and two
    // appointments can share a slot across clinicians.
    expect(
      findAppointment([appointmentRow({ patientId: 'pat-2' })], PATIENT_ID, SCHEDULED_AT),
    ).toBeUndefined();
  });

  it('skips a row with no usable duration rather than inventing one', () => {
    expect(
      findAppointment([appointmentRow({ durationMinutes: undefined })], PATIENT_ID, SCHEDULED_AT),
    ).toBeUndefined();
  });

  it('skips an unparseable scheduledAt', () => {
    expect(
      findAppointment([appointmentRow({ scheduledAt: 'not a date' })], PATIENT_ID, SCHEDULED_AT),
    ).toBeUndefined();
  });

  it('carries the status through, so a cancelled booking can say so', () => {
    const found = findAppointment(
      [appointmentRow({ appointment_status: 'pending-approval' })],
      PATIENT_ID,
      SCHEDULED_AT,
    );
    expect(found?.status).toBe('pending-approval');
  });
});

describe('calendarWindow', () => {
  it('brackets the appointment itself', () => {
    // `resolveRole` used to ask for `[epoch, now + 24h)`, which answers the
    // role question but cannot see an appointment further out than tomorrow
    // — and this probe needs the row.
    expect(calendarWindow(SCHEDULED_AT)).toEqual({
      from: '2026-08-31T10:00:00.000Z',
      to: '2026-09-02T10:00:00.000Z',
    });
  });
});
