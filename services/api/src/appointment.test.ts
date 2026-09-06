import type { Appointment, Patient, PatientNotification } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import type { AppointmentStore, AppointmentTransition } from './appointment-repository.js';
import { AppointmentRepository } from './appointment-repository.js';
import { createAppointmentHandler } from './appointment.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import type { PatientNotificationStore } from './patient-notification-repository.js';
import { PatientNotificationRepository } from './patient-notification-repository.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const OWNER_ACTOR = actorContext(
  { subjectId: 'pat-1', role: 'patient' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

const OWNING_PATIENT_CONTEXT = {
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};

const ASSIGNED_SUB_CONTEXT = {
  subjectId: 'sub-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-1',
};

const UNASSIGNED_SUB_CONTEXT = {
  subjectId: 'sub-2',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-2',
};

const PRINCIPAL_CONTEXT = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};

/**
 * 2026-09-06. A helpdesk *is* a `CLI#` row and so carries a `clinicianId` —
 * `cli-hd`, which no patient is ever assigned to. That is the whole reason
 * the calendar route expands "me" to the practice for this role: their own
 * id can only ever answer with nothing.
 */
const HELPDESK_CONTEXT = {
  subjectId: 'cli-hd',
  role: 'helpdesk',
  accountStatus: 'active',
  clinicianId: 'cli-hd',
};

/** In-memory `AppointmentStore` — this file exercises `appointment.ts`'s own routing/authz logic; the real Query/BETWEEN shape is `dynamo-store.test.ts`'s job. */
class InMemoryAppointmentStore implements AppointmentStore {
  private readonly items: Appointment[] = [];

  async create(appointment: Appointment): Promise<void> {
    const collides = this.items.some(
      (item) => item.patientId === appointment.patientId && item.scheduledAt === appointment.scheduledAt,
    );
    if (collides) {
      throw new AppError(
        'APPOINTMENT_ALREADY_EXISTS',
        `patient ${appointment.patientId} already has an appointment at ${appointment.scheduledAt}`,
      );
    }
    this.items.push(appointment);
  }

  async get(patientId: string, scheduledAt: string): Promise<Appointment | undefined> {
    return this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
  }

  async listForPatient(patientId: string): Promise<Appointment[]> {
    return this.items
      .filter((item) => item.patientId === patientId)
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  async listForClinicianCalendar(
    clinicianId: string,
    from: string,
    to: string,
  ): Promise<Appointment[]> {
    return this.items
      .filter(
        (item) =>
          item.clinicianId === clinicianId &&
          item.scheduledAt >= from &&
          item.scheduledAt <= to &&
          item.appointment_status !== 'cancelled',
      )
      .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  }

  async transition(
    patientId: string,
    scheduledAt: string,
    change: AppointmentTransition,
  ): Promise<Appointment> {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    if (!item) {
      throw new AppError('RECORD_NOT_FOUND', `no appointment for patient ${patientId} at ${scheduledAt}`);
    }
    if (change.expect && item.appointment_status !== change.expect) {
      throw new AppError(
        'APPOINTMENT_STATE_CONFLICT',
        `appointment for patient ${patientId} at ${scheduledAt} is ${item.appointment_status}, not ${change.expect}`,
      );
    }
    const updated: Appointment = {
      ...item,
      appointment_status: change.to,
      updated_at: change.now,
      ...(change.decidedBy ? { approvedBy: change.decidedBy, approvedAt: change.now } : {}),
    };
    this.items[this.items.indexOf(item)] = updated;
    return updated;
  }
}

/** 2026-09-01: the patient's in-app feed, in memory. Every calendar route writes one; this is how a test reads them back. */
class InMemoryPatientNotificationStore implements PatientNotificationStore {
  readonly items: PatientNotification[] = [];

  async create(notification: PatientNotification): Promise<void> {
    this.items.push(notification);
  }

  async listForPatient(patientId: string, limit: number): Promise<PatientNotification[]> {
    return this.items
      .filter((item) => item.patientId === patientId)
      .sort((a, b) => b.notificationId.localeCompare(a.notificationId))
      .slice(0, limit);
  }

  async markRead(
    patientId: string,
    notificationId: string,
  ): Promise<PatientNotification | undefined> {
    const item = this.items.find(
      (it) => it.patientId === patientId && it.notificationId === notificationId,
    );
    if (!item) {
      return undefined;
    }
    const updated = { ...item, read: true };
    this.items[this.items.indexOf(item)] = updated;
    return updated;
  }
}

function fakeEvent(overrides: {
  routeKey: string;
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: unknown;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey,
    pathParameters: overrides.pathParameters,
    queryStringParameters: overrides.queryStringParameters,
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : ASSIGNED_SUB_CONTEXT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

async function build(overrides: { flagEnabled?: boolean } = {}) {
  const patientStore = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  const patients = new PatientRepository(patientStore, audit, clock);
  await patients.register(
    {
      subjectId: 'pat-1',
      personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
    },
    OWNER_ACTOR,
  );
  const existing = await patientStore.get('pat-1');
  if (existing) {
    await patientStore.put('pat-1', { ...existing, assigned_clinician_id: 'cli-1' });
  }

  const appointments = new AppointmentRepository(
    new InMemoryAppointmentStore(),
    new InMemoryAuditLog(),
    clock,
  );

  const flagSource = new InMemoryFlagSource();
  flagSource.set('appointments.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const notificationStore = new InMemoryPatientNotificationStore();
  let notificationSeq = 0;
  const notifications = new PatientNotificationRepository(notificationStore, clock, {
    // A fixed clock would otherwise give every notice the same id, and the
    // feed's whole ordering guarantee rests on the id being unique.
    newId: () => `n${(notificationSeq += 1)}`,
  });

  // 2026-09-06: the directory the two read routes join display names from.
  // `cli-1` is the clinician `pat-1` is assigned to above, so a calendar row
  // for that pair resolves both names and the negative cases (an unassigned
  // clinician, a caller who may not read the profile) stay expressible.
  const clinicians = new ClinicianRepository(
    new InMemoryClinicianStore(),
    new InMemoryAuditLog(),
    clock,
  );
  await clinicians.create(
    'cli-1',
    { displayName: 'A Clinician', role: 'sub' },
    OWNER_ACTOR,
  );
  // In the directory but never in the fan-out: a helpdesk row owns no
  // appointment, so querying GSI1 for it could only ever return nothing.
  // `the practice's calendar` below asserts it is skipped rather than merely
  // returning empty.
  await clinicians.create(
    'cli-hd',
    { displayName: 'A Helpdesk', role: 'helpdesk' },
    OWNER_ACTOR,
  );

  const handler = createAppointmentHandler({
    patients,
    appointments,
    clinicians,
    notifications,
    flags,
    clock,
  });
  return { handler, patients, appointments, clinicians, patientStore, notificationStore };
}

async function invoke(
  handler: ReturnType<typeof createAppointmentHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const SCHEDULE_ROUTE = 'POST /patients/{id}/appointments';
const PATIENT_LIST_ROUTE = 'GET /patients/{id}/appointments';
const CALENDAR_ROUTE = 'GET /clinicians/me/calendar';
const CANCEL_ROUTE = 'POST /patients/{id}/appointments/{apptId}/cancel';

const APPROVE_ROUTE = 'POST /patients/{id}/appointments/{apptId}/approve';
const DECLINE_ROUTE = 'POST /patients/{id}/appointments/{apptId}/decline';

describe('POST /patients/{id}/appointments', () => {
  it('books an appointment for an assigned sub-clinician — pending the principal\'s approval', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      item: { patientId: string; clinicianId: string; scheduledAt: string; appointment_status: string };
    };
    expect(body.item.patientId).toBe('pat-1');
    expect(body.item.clinicianId).toBe('cli-1');
    // 2026-09-01: "any new appointment booked by the clinician needs to be
    // approved by the principal clinician."
    expect(body.item.appointment_status).toBe('pending-approval');
  });

  it('is 409, not a silent double-booking, when the patient already has an appointment at that instant', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 45 },
      }),
    );
    expect(response.statusCode).toBe(409);
  });

  it('lets the principal schedule — the practice\'s own practising clinician, not an overseer', async () => {
    const { handler, appointments } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    // Flipped 2026-08-31 with the doc's `Principal` column: the
    // read-only cell this test guarded rested on the principal being an
    // overseer who never treats anyone, which is not who the principal
    // is in this practice. See docs/plan/04-data-model-rbac.md's own
    // second amendment of that date.
    expect(response.statusCode).toBe(201);
    await expect(appointments.listForPatient('pat-1')).resolves.toHaveLength(1);
  });

  it('is 403 for an unassigned sub-clinician, before any write', async () => {
    const { handler, appointments } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(appointments.listForPatient('pat-1')).resolves.toEqual([]);
  });

  it('is 403 for the owning patient — the row grants bare R to the patient column', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
        principal: undefined,
      }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 400 for a non-ISO scheduledAt or a missing durationMinutes', async () => {
    const { handler } = await build();
    const badDate = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: 'not-a-date', durationMinutes: 30 },
      }),
    );
    expect(badDate.statusCode).toBe(400);

    const missingDuration = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z' },
      }),
    );
    expect(missingDuration.statusCode).toBe(400);
  });

  it('is 400 for an unrecognised body field — a smuggled clinicianId fails the parse, not silently accepted', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: {
          scheduledAt: '2026-09-01T10:00:00.000Z',
          durationMinutes: 30,
          clinicianId: 'someone-else',
        },
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 403, not 404, for a caller the matrix denies — the refusal must not leak whether the patient exists', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'nobody' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    // Flipped 2026-08-31 with the doc's `Principal` column (see
    // 04-data-model-rbac.md's second amendment of that date). The
    // ordering property this test guards is unchanged and still worth
    // asserting — it has simply moved to the role the matrix still
    // denies here. A caller the matrix refuses must not learn from the
    // status code whether the patient exists.
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /patients/{id}/appointments', () => {
  async function seedTwo(handler: ReturnType<typeof createAppointmentHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-02T10:00:00.000Z', durationMinutes: 30 },
      }),
    );
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      }),
    );
  }

  it('returns the owning patient\'s own list, chronologically', async () => {
    const { handler } = await build();
    await seedTwo(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: { scheduledAt: string }[] };
    expect(body.items.map((item) => item.scheduledAt)).toEqual([
      '2026-09-01T10:00:00.000Z',
      '2026-09-02T10:00:00.000Z',
    ]);
  });

  it('resolves /patients/me/appointments to the owning patient', async () => {
    const { handler } = await build();
    await seedTwo(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'me' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it('is 200 for an assigned sub-clinician and for the principal', async () => {
    const { handler } = await build();
    await seedTwo(handler);

    const subResponse = await invoke(
      handler,
      fakeEvent({ routeKey: PATIENT_LIST_ROUTE, pathParameters: { id: 'pat-1' } }),
    );
    expect(subResponse.statusCode).toBe(200);

    const principalResponse = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(principalResponse.statusCode).toBe(200);
  });

  it('is 403 for an unassigned sub-clinician', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 403, never a 200 with a partial body, for a patient reading another patient\'s list by a guessed id', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: { ...OWNING_PATIENT_CONTEXT, subjectId: 'pat-2', patientId: 'pat-2' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: PATIENT_LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: undefined }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: PATIENT_LIST_ROUTE, pathParameters: { id: 'pat-1' } }),
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /clinicians/me/calendar', () => {
  async function seedCalendar(handler: ReturnType<typeof createAppointmentHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      }),
    );
  }

  it('returns exactly the assigned sub-clinician\'s own appointments within range', async () => {
    const { handler } = await build();
    await seedCalendar(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: { clinicianId: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.clinicianId).toBe('cli-1');
  });

  it('is 200 (possibly empty) for the principal — a clinician-shaped resource, not a patient-scoped one', async () => {
    const { handler } = await build();
    await seedCalendar(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('is 403 for a patient — this route has no patient-relationship path to grant one', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 400 when from or to is missing', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: CALENDAR_ROUTE, queryStringParameters: { from: '2026-09-01T00:00:00.000Z' } }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
        principal: undefined,
      }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});

// 2026-09-06: *"for help desk I want to show on the landing dashboard both
// ready only calender and patient dashboard — the two stuff the principal
// clinician is seeing but in read only mode."*
describe('a helpdesk reads the practice\'s calendar, not their own empty one', () => {
  async function seedForCli1(handler: ReturnType<typeof createAppointmentHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: '2026-09-01T10:00:00.000Z', durationMinutes: 30 },
      }),
    );
  }

  const RANGE = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' };

  it('returns another clinician\'s appointment — the row their own id could never find', async () => {
    const { handler } = await build();
    await seedForCli1(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: RANGE,
        principal: HELPDESK_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: { clinicianId: string }[] };
    expect(body.items).toHaveLength(1);
    // `cli-1`, not `cli-hd` — the whole point of the expansion.
    expect(body.items[0]?.clinicianId).toBe('cli-1');
  });

  it('queries only the treating clinicians, never the helpdesk row beside them', async () => {
    const { handler, appointments } = await build();
    await seedForCli1(handler);
    const listFor = vi.spyOn(appointments, 'listForClinicianCalendar');
    await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: RANGE,
        principal: HELPDESK_CONTEXT,
      }),
    );
    expect(listFor.mock.calls.map((call) => call[0])).toEqual(['cli-1']);
  });

  it('leaves a sub-clinician\'s own calendar exactly as it was', async () => {
    // The regression guard on this change's central claim: the expansion is
    // derived from the caller's role and is not a `clinicianId` anyone can
    // supply, so every other role's answer is byte-for-byte unchanged.
    const { handler, appointments } = await build();
    await seedForCli1(handler);
    const listFor = vi.spyOn(appointments, 'listForClinicianCalendar');
    await invoke(
      handler,
      fakeEvent({ routeKey: CALENDAR_ROUTE, queryStringParameters: RANGE }),
    );
    expect(listFor.mock.calls.map((call) => call[0])).toEqual(['cli-1']);
    expect(listFor).toHaveBeenCalledTimes(1);
  });
});

// 2026-09-06: *"on calender when we click an appointment it should also show
// the name of the patient and the name of the clinician."* The row stores two
// ids and no names, so both routes join them on the way out.
describe('the two names an appointment is about', () => {
  async function seedOne(handler: ReturnType<typeof createAppointmentHandler>, at: string) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: at, durationMinutes: 30 },
      }),
    );
  }

  type NamedItem = {
    readonly patientId: string;
    readonly clinicianId: string;
    readonly patientName?: string;
    readonly clinicianName?: string;
  };

  const itemsOf = (body: string): NamedItem[] => (JSON.parse(body) as { items: NamedItem[] }).items;

  it('carries both names on the clinician calendar', async () => {
    const { handler } = await build();
    await seedOne(handler, '2026-09-01T10:00:00.000Z');
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(itemsOf(response.body)[0]).toMatchObject({
      patientName: 'A Patient',
      clinicianName: 'A Clinician',
    });
  });

  it('carries both names on the patient\'s own list', async () => {
    const { handler } = await build();
    await seedOne(handler, '2026-09-01T10:00:00.000Z');
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'me' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    // The patient's own name is theirs to see by definition; the clinician's
    // is the half of this request that actually tells them something.
    expect(itemsOf(response.body)[0]).toMatchObject({
      patientName: 'A Patient',
      clinicianName: 'A Clinician',
    });
  });

  it('omits a name it cannot resolve rather than falling back to the id', async () => {
    // `caseload-repository.ts` does fall back to the id for its own table
    // column. This must not: a raw Cognito `sub` rendered where a person's
    // name belongs is worse than no line at all, and the client drops the
    // line entirely when the field is absent.
    const { handler, clinicians } = await build();
    vi.spyOn(clinicians, 'findById').mockResolvedValue(undefined);
    await seedOne(handler, '2026-09-01T10:00:00.000Z');
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
      }),
    );
    const item = itemsOf(response.body)[0];
    // Absent, not blank and not the id — the key never reaches the wire, so
    // the client can distinguish "no name" from "a name that is empty".
    expect(item && 'clinicianName' in item).toBe(false);
    // The row itself is unaffected — a missing name is cosmetic, never a
    // reason to drop an appointment the caller is entitled to.
    expect(item?.clinicianId).toBe('cli-1');
  });

  it('survives a directory read that throws, rather than 500ing the calendar', async () => {
    const { handler, clinicians } = await build();
    vi.spyOn(clinicians, 'findById').mockRejectedValue(new Error('directory down'));
    await seedOne(handler, '2026-09-01T10:00:00.000Z');
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(itemsOf(response.body)[0]?.clinicianName).toBeUndefined();
  });

  it('reads each distinct id once, however many rows name it', async () => {
    // The guarantee that keeps this from being two extra DynamoDB reads per
    // appointment: a fortnight of one clinician's calendar is one clinician
    // and a handful of patients, so the per-request cache is what makes the
    // join affordable at all. Caching the *promise* is what makes it hold
    // for the concurrent lookups inside one `Promise.all`.
    const { handler, clinicians } = await build();
    const findById = vi.spyOn(clinicians, 'findById');
    await seedOne(handler, '2026-09-01T10:00:00.000Z');
    await seedOne(handler, '2026-09-01T12:00:00.000Z');
    await seedOne(handler, '2026-09-01T14:00:00.000Z');
    findById.mockClear();

    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
      }),
    );
    expect(itemsOf(response.body)).toHaveLength(3);
    expect(findById).toHaveBeenCalledTimes(1);
  });
});

describe('POST /patients/{id}/appointments/{apptId}/cancel', () => {
  const APPT_ID = '2026-09-01T10:00:00.000Z';

  async function seedOne(handler: ReturnType<typeof createAppointmentHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_ID, durationMinutes: 30 },
      }),
    );
  }

  it('cancels the appointment for an assigned sub-clinician, leaving the row readable', async () => {
    const { handler } = await build();
    await seedOne(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CANCEL_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_ID },
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { item: { appointment_status: string } };
    expect(body.item.appointment_status).toBe('cancelled');
  });

  it('excludes the cancelled appointment from the clinician calendar but keeps it in the patient\'s own history', async () => {
    const { handler } = await build();
    await seedOne(handler);
    await invoke(
      handler,
      fakeEvent({ routeKey: CANCEL_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_ID } }),
    );

    const calendar = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: { from: '2026-09-01T00:00:00.000Z', to: '2026-09-02T00:00:00.000Z' },
      }),
    );
    expect(JSON.parse(calendar.body)).toEqual({ items: [] });

    const history = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    const body = JSON.parse(history.body) as { items: { appointment_status: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.appointment_status).toBe('cancelled');
  });

  it('lets the principal cancel — the same Appointments row column as create', async () => {
    const { handler } = await build();
    await seedOne(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CANCEL_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_ID },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    // Flipped 2026-08-31 with the doc's `Principal` column: the
    // read-only cell this test guarded rested on the principal being an
    // overseer who never treats anyone, which is not who the principal
    // is in this practice. See docs/plan/04-data-model-rbac.md's own
    // second amendment of that date.
    expect(response.statusCode).toBe(200);
  });

  it('is 403 for the owning patient — cancelling one\'s own appointment is out of scope for this route', async () => {
    const { handler } = await build();
    await seedOne(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CANCEL_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_ID },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 403 for an unassigned sub-clinician', async () => {
    const { handler } = await build();
    await seedOne(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CANCEL_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_ID },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 404, not a silent no-op, for an appointment that was never scheduled', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CANCEL_ROUTE,
        pathParameters: { id: 'pat-1', apptId: '2026-12-25T09:00:00.000Z' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: CANCEL_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_ID },
        principal: undefined,
      }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: CANCEL_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_ID } }),
    );
    expect(response.statusCode).toBe(404);
  });
});

// 2026-09-01: the approval step, end to end at the route level. The
// repository's own suite proves the transitions; this one proves that
// *only the principal* can reach them, which is the whole point of the
// `Appointment approval` row being separate from `Appointments`.
describe('the approval step — POST …/approve and …/decline', () => {
  const APPT_AT = '2026-09-01T10:00:00.000Z';

  /** Books as the assigned sub-clinician, which is the only way a `pending-approval` row is created. */
  async function bookPending(handler: ReturnType<typeof createAppointmentHandler>) {
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );
    expect(response.statusCode).toBe(201);
  }

  it('confirms a pending booking for the principal', async () => {
    const { handler } = await build();
    await bookPending(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      item: { appointment_status: string; approvedBy: string };
    };
    expect(body.item.appointment_status).toBe('scheduled');
    expect(body.item.approvedBy).toBe('principal-sub');
  });

  it('is 403 for the assigned sub-clinician — booking and approving are two different powers', async () => {
    const { handler } = await build();
    await bookPending(handler);
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: APPROVE_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    expect(response.statusCode).toBe(403);
  });

  it.each([
    ['the owning patient', OWNING_PATIENT_CONTEXT],
    ['an unassigned sub-clinician', UNASSIGNED_SUB_CONTEXT],
    ['a helpdesk account', { subjectId: 'hd-1', role: 'helpdesk', accountStatus: 'active', clinicianId: 'hd-1' }],
    ['a visitor account', { subjectId: 'vis-1', role: 'visitor', accountStatus: 'active', clinicianId: 'vis-1' }],
  ])('is 403 for %s', async (_label, principal) => {
    const { handler } = await build();
    await bookPending(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('declines a pending booking to cancelled, and refuses a second decision on it', async () => {
    const { handler } = await build();
    await bookPending(handler);
    const declined = await invoke(
      handler,
      fakeEvent({
        routeKey: DECLINE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(declined.statusCode).toBe(200);
    expect(
      (JSON.parse(declined.body) as { item: { appointment_status: string } }).item
        .appointment_status,
    ).toBe('cancelled');

    const second = await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(second.statusCode).toBe(409);
  });

  it('is 404 for an appointment that was never booked', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  // **2026-09-02: was "confirms the principal's own booking immediately".**
  // The owner: "when I assign an appointment to a patient, it should be
  // visible to patient dashboard to be approved by principal clinician
  // before it appears to patient profile."
  //
  // The exemption rested on "the approver approving themselves is a step
  // with no decision in it", which was wrong about what the step is for:
  // it is the gate that decides when a booking becomes real *to the
  // patient*, not the principal proving something to themselves.
  it('holds the principal\'s own booking for approval too — the gate is what the patient sees, not who typed it', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(201);
    expect(
      (JSON.parse(response.body) as { item: { appointment_status: string } }).item
        .appointment_status,
    ).toBe('pending-approval');
  });
});

// 2026-09-03: who an appointment belongs to.
//
// The owner: *"when I as a principal clinician approve a booking for an
// appointment for a patient in pathients account I see a join the call
// button. But the clinician who has been assigned this patient doesnt see
// any join the call button."*
//
// `clinicianId` is not bookkeeping — `gsi1pk` keys the clinician calendar
// on it, and `ws-join.ts` checks `join-call` against it. Setting it to
// whoever booked meant a principal-booked appointment appeared on the
// principal's calendar, joinable by them, and was invisible and
// unjoinable to the clinician actually treating the patient.
describe('an appointment belongs to the patient’s clinician, not to whoever booked it', () => {
  const APPT_AT = '2026-09-01T10:00:00.000Z';

  it('attaches a principal’s booking to the assigned sub-clinician', async () => {
    const { handler, appointments } = await build();

    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );

    const created = await appointments.get('pat-1', APPT_AT);
    expect(created?.clinicianId).toBe('cli-1');
  });

  it('puts it on the assigned clinician’s calendar, and not the principal’s', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );

    const range = { from: '2026-08-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' };
    const mine = await invoke(
      handler,
      fakeEvent({ routeKey: CALENDAR_ROUTE, queryStringParameters: range }),
    );
    const principals = await invoke(
      handler,
      fakeEvent({
        routeKey: CALENDAR_ROUTE,
        queryStringParameters: range,
        principal: PRINCIPAL_CONTEXT,
      }),
    );

    expect((JSON.parse(mine.body) as { items: unknown[] }).items).toHaveLength(1);
    expect((JSON.parse(principals.body) as { items: unknown[] }).items).toEqual([]);
  });

  it('still attaches a sub-clinician’s own booking to themselves', async () => {
    const { handler, appointments } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );

    expect((await appointments.get('pat-1', APPT_AT))?.clinicianId).toBe('cli-1');
  });

  it('falls back to the booker when the patient has no clinician yet', async () => {
    // Only the principal can book for an unassigned patient at all, and an
    // appointment has to belong to somebody — better the person who made
    // it than nobody.
    const { handler, appointments, patientStore } = await build();
    const patient = await patientStore.get('pat-1');
    if (patient) {
      // `assigned_clinician_id` is optional on `Patient`, so clearing it
      // is an assignment rather than a deletion — no cast, no discarded
      // binding, and `?? principal.clinicianId` reads `undefined` exactly
      // as it would read an absent key.
      await patientStore.put('pat-1', { ...patient, assigned_clinician_id: undefined });
    }

    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );

    expect((await appointments.get('pat-1', APPT_AT))?.clinicianId).toBe('principal-sub');
  });
});

// 2026-09-01: "When a clinician/principal clinician edits a calender for a
// given patient it will appear as a notification on patients logged in
// dashboard."
//
// **Rewritten 2026-09-02 around one rule: a patient hears about an
// appointment only once it is real to them.** The owner: *"I dont want to
// see 'Your clinician has requested an appointment. It is waiting to be
// confirmed.' … I only want to see confirmed appointments."*
//
// The original read "every route that moves an appointment writes exactly
// one notification", which is a tidy rule about *routes* and the wrong rule
// about *people*. It announced a request the moment it was made — undoing
// the approval gate in the only place the gate is felt — and, following the
// same symmetry, would have announced the cancellation of a slot the
// patient had never been allowed to know about. `summariseCalendar` already
// had this right for "next appointment"; the feed did not.
describe('the patient dashboard feed', () => {
  const APPT_AT = '2026-09-01T10:00:00.000Z';

  it('says nothing when a sub-clinician books, and announces the approval', async () => {
    const { handler, notificationStore } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );
    expect(notificationStore.items).toEqual([]);

    await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(notificationStore.items.map((item) => item.kind)).toEqual(['appointment-approved']);
    // The notice is *about* the appointment's time, not the time it was
    // written — those are two different facts and the record keeps both.
    expect(notificationStore.items[0]?.subjectAt).toBe(APPT_AT);
    expect(notificationStore.items[0]?.patientId).toBe('pat-1');
    expect(notificationStore.items[0]?.read).toBe(false);
  });

  it('says nothing when the principal books either — the gate is the same for everyone', async () => {
    const { handler, notificationStore } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(notificationStore.items).toEqual([]);
  });

  it('says nothing when a request is declined — the patient never knew it existed', async () => {
    const { handler, notificationStore } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );
    await invoke(
      handler,
      fakeEvent({
        routeKey: DECLINE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    // "Your appointment was cancelled" about a slot they were never told
    // they had is worse than silence, and would leak the existence of the
    // request the gate had just rejected.
    expect(notificationStore.items).toEqual([]);
  });

  it('says nothing when a still-pending booking is withdrawn', async () => {
    const { handler, notificationStore } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    await invoke(
      handler,
      fakeEvent({ routeKey: CANCEL_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    expect(notificationStore.items).toEqual([]);
  });

  it('announces the cancellation of a confirmed appointment — that one was real', async () => {
    const { handler, notificationStore } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    await invoke(
      handler,
      fakeEvent({ routeKey: CANCEL_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    // The patient was told this appointment existed and may have planned
    // around it. Withdrawing it silently is the one failure worse than
    // announcing it.
    expect(notificationStore.items.map((item) => item.kind)).toEqual([
      'appointment-approved',
      'appointment-cancelled',
    ]);
  });

  it('carries no prose — a kind, a time and an actor id, never a message anyone authored', async () => {
    const { handler, notificationStore } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );
    await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(Object.keys(notificationStore.items[0] ?? {}).sort()).toEqual([
      'actorId',
      'created_at',
      'kind',
      'notificationId',
      'patientId',
      'read',
      'status',
      'subjectAt',
      'updated_at',
    ]);
  });

  it('still approves the appointment when the feed write fails — and says so', async () => {
    const { handler, notificationStore } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );
    notificationStore.create = () => Promise.reject(new Error('dynamo is having a day'));
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: APPROVE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { notified: boolean }).notified).toBe(false);
  });

  it('reports no `notified` at all on a booking, rather than a misleading false', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );
    // `notified: false` means "a notification was owed and did not land".
    // Nothing is owed here, so the field is absent — the two are different
    // facts and a caller can act on the difference.
    expect(Object.hasOwn(JSON.parse(response.body) as object, 'notified')).toBe(false);
  });
});

// 2026-09-01: marking attendance. TASK 3.4.2 named `completed`/`no-show`
// as the reason this field has four states and built no route for either,
// so `appointment_status` had never once been `'completed'` anywhere —
// which the calendar section's "sessions so far" and the visitor's
// "number of appointments happened" both count.
describe('marking attendance — POST …/complete and …/no-show', () => {
  const APPT_AT = '2026-09-01T10:00:00.000Z';
  const COMPLETE_ROUTE = 'POST /patients/{id}/appointments/{apptId}/complete';
  const NO_SHOW_ROUTE = 'POST /patients/{id}/appointments/{apptId}/no-show';

  /**
   * Books and then approves — since 2026-09-02 every booking lands
   * `pending-approval`, so "confirmed" is two steps for everyone, the
   * principal included.
   */
  async function bookConfirmed(handler: ReturnType<typeof createAppointmentHandler>) {
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(201);
    const approved = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/appointments/{apptId}/approve',
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(approved.statusCode).toBe(200);
  }

  it.each([
    ['the assigned sub-clinician', ASSIGNED_SUB_CONTEXT],
    ['the principal', PRINCIPAL_CONTEXT],
  ])('lets %s mark a confirmed appointment completed', async (_label, principal) => {
    const { handler } = await build();
    await bookConfirmed(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: COMPLETE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(
      (JSON.parse(response.body) as { item: { appointment_status: string } }).item
        .appointment_status,
    ).toBe('completed');
  });

  it('records a no-show separately — it happened in the calendar, not in the room', async () => {
    const { handler } = await build();
    await bookConfirmed(handler);
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: NO_SHOW_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    expect(response.statusCode).toBe(200);
    expect(
      (JSON.parse(response.body) as { item: { appointment_status: string } }).item
        .appointment_status,
    ).toBe('no-show');
  });

  it('is 409 for an appointment still awaiting approval — it has not taken place', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: COMPLETE_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    expect(response.statusCode).toBe(409);
  });

  it('is 409 for a cancelled appointment, and for one already marked', async () => {
    const { handler } = await build();
    await bookConfirmed(handler);
    await invoke(
      handler,
      fakeEvent({ routeKey: COMPLETE_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    const twice = await invoke(
      handler,
      fakeEvent({ routeKey: COMPLETE_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    expect(twice.statusCode).toBe(409);
  });

  it.each([
    ['the owning patient', OWNING_PATIENT_CONTEXT],
    ['an unassigned sub-clinician', UNASSIGNED_SUB_CONTEXT],
    ['a helpdesk account', { subjectId: 'hd-1', role: 'helpdesk', accountStatus: 'active', clinicianId: 'hd-1' }],
    ['a visitor account', { subjectId: 'vis-1', role: 'visitor', accountStatus: 'active', clinicianId: 'vis-1' }],
  ])('is 403 for %s', async (_label, principal) => {
    const { handler } = await build();
    await bookConfirmed(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: COMPLETE_ROUTE,
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('writes no dashboard notice — the feed is for what is coming, not what already happened', async () => {
    const { handler, notificationStore } = await build();
    await bookConfirmed(handler);
    const before = notificationStore.items.length;
    await invoke(
      handler,
      fakeEvent({ routeKey: COMPLETE_ROUTE, pathParameters: { id: 'pat-1', apptId: APPT_AT } }),
    );
    expect(notificationStore.items).toHaveLength(before);
  });
});

// 2026-09-02: the property the owner actually asked for — a booking is
// invisible to the patient until the principal has approved it. Asserted
// against what a patient's own surfaces read, not against the raw row.
describe('a booking reaches the patient only once it is approved', () => {
  const APPT_AT = '2026-09-05T10:00:00.000Z';

  async function booked(principal: Record<string, unknown>) {
    const built = await build();
    const response = await invoke(
      built.handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal,
      }),
    );
    expect(response.statusCode).toBe(201);
    return built;
  }

  it.each([
    ['the principal', PRINCIPAL_CONTEXT],
    ['the assigned clinician', ASSIGNED_SUB_CONTEXT],
  ])('is pending, whoever booked it — %s', async (_label, principal) => {
    const { handler } = await booked(principal);
    const list = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'me' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    const items = (JSON.parse(list.body) as { items: { appointment_status: string }[] }).items;
    expect(items.map((item) => item.appointment_status)).toEqual(['pending-approval']);
  });

  it('becomes confirmed only after the principal approves', async () => {
    const { handler } = await booked(PRINCIPAL_CONTEXT);
    await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/appointments/{apptId}/approve',
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    const list = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'me' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    const items = (JSON.parse(list.body) as { items: { appointment_status: string }[] }).items;
    expect(items.map((item) => item.appointment_status)).toEqual(['scheduled']);
  });

  it('a declined booking never becomes confirmed', async () => {
    const { handler } = await booked(ASSIGNED_SUB_CONTEXT);
    await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/appointments/{apptId}/decline',
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    const list = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'me' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    const items = (JSON.parse(list.body) as { items: { appointment_status: string }[] }).items;
    expect(items.map((item) => item.appointment_status)).toEqual(['cancelled']);
  });
});

// 2026-09-02: "even a clinician can approve this appointment. This
// approval is only reserved to principal clinician."
//
// The report was about the *button being offered* — the server has refused
// every non-principal since the row was added. These assertions exist so
// that stays true and provable, against every role in the table rather
// than the two the earlier tests happened to name.
describe('approval is the principal’s alone, at the route', () => {
  const APPT_AT = '2026-09-01T10:00:00.000Z';

  async function pending() {
    const built = await build();
    const response = await invoke(
      built.handler,
      fakeEvent({
        routeKey: SCHEDULE_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { scheduledAt: APPT_AT, durationMinutes: 30 },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(201);
    return built;
  }

  it.each([
    ['the assigned clinician', ASSIGNED_SUB_CONTEXT],
    ['an unassigned clinician', UNASSIGNED_SUB_CONTEXT],
    ['helpdesk', { subjectId: 'hd-1', role: 'helpdesk', accountStatus: 'active', clinicianId: 'hd-1' }],
    ['a visitor', { subjectId: 'vis-1', role: 'visitor', accountStatus: 'active', clinicianId: 'vis-1' }],
    ['the owning patient', OWNING_PATIENT_CONTEXT],
  ])('refuses approve from %s, and leaves the booking pending', async (_label, principal) => {
    const { handler } = await pending();
    for (const decision of ['approve', 'decline']) {
      const response = await invoke(
        handler,
        fakeEvent({
          routeKey: `POST /patients/{id}/appointments/{apptId}/${decision}`,
          pathParameters: { id: 'pat-1', apptId: APPT_AT },
          principal,
        }),
      );
      expect(response.statusCode).toBe(403);
    }

    // And the row is untouched — a refused decision must not half-apply.
    const list = await invoke(
      handler,
      fakeEvent({
        routeKey: PATIENT_LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    const items = (JSON.parse(list.body) as { items: { appointment_status: string }[] }).items;
    expect(items.map((item) => item.appointment_status)).toEqual(['pending-approval']);
  });

  it('a clinician cannot reach the same transition through the attendance routes either', async () => {
    const { handler } = await pending();
    // `complete` rides `Appointments: update`, which the assigned
    // clinician does hold — the guard is `expect: 'scheduled'`, so a
    // pending booking cannot be walked into a confirmed one this way.
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/appointments/{apptId}/complete',
        pathParameters: { id: 'pat-1', apptId: APPT_AT },
      }),
    );
    expect(response.statusCode).toBe(409);
  });
});
