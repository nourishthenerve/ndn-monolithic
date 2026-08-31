import type { Appointment, Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import type { AppointmentStore } from './appointment-repository.js';
import { AppointmentRepository } from './appointment-repository.js';
import { createAppointmentHandler } from './appointment.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
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

  async cancel(patientId: string, scheduledAt: string, now: string): Promise<Appointment> {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    if (!item) {
      throw new AppError('RECORD_NOT_FOUND', `no appointment for patient ${patientId} at ${scheduledAt}`);
    }
    const updated: Appointment = { ...item, appointment_status: 'cancelled', updated_at: now };
    const index = this.items.indexOf(item);
    this.items[index] = updated;
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

  const handler = createAppointmentHandler({ patients, appointments, flags, clock });
  return { handler, patients, appointments };
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

describe('POST /patients/{id}/appointments', () => {
  it('schedules an appointment for an assigned sub-clinician', async () => {
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
    expect(body.item.appointment_status).toBe('scheduled');
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
