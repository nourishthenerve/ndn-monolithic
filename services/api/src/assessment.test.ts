// 2026-09-01: rewritten for the four-section form. The owner's rules, one
// describe block each:
//
//   * "The patient will be able to edit his general info only."
//   * "The helpdesk can only edit specific to the patient section as well
//     as general section."
//   * "The clinician/principal clinican can edit all the sections."
//   * "[the visitor] will only be able to see the general info contant of
//     only those patients that have been tagged IIC."
//   * "[the calendar] will be edited by the clinician/principal clinician
//     and helpdesk/visitor/patient will only be able to read it."
//
// R-09's own standing rule is asserted here too, unchanged in substance
// and now per-section: a patient reaches no clinician-section field, in
// any relationship, on any route, in any response shape.
import type { Appointment, Assessment, Patient, PatientNotification } from '@ndn/shared-types';
import { ASSESSMENT_TAG_FIELD_ID } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import type { AppointmentStore, AppointmentTransition } from './appointment-repository.js';
import { AppointmentRepository } from './appointment-repository.js';
import { AssessmentRepository, DEFAULT_ASSESSMENT_ID } from './assessment-repository.js';
import { createAssessmentHandler } from './assessment.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import type { PatientNotificationStore } from './patient-notification-repository.js';
import { PatientNotificationRepository } from './patient-notification-repository.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryStore } from './store.js';

const NOW = '2026-08-22T09:00:00.000Z';
const clock: Clock = { now: () => new Date(NOW) };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const SEED_ACTOR = actorContext(
  { subjectId: 'seed', role: 'principal-clinician' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

const OWNING_PATIENT = {
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};
const OTHER_PATIENT = {
  subjectId: 'pat-9',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-9',
};
const ASSIGNED_SUB = {
  subjectId: 'sub-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-1',
};
const UNASSIGNED_SUB = {
  subjectId: 'sub-2',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-2',
};
const PRINCIPAL = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};
const HELPDESK = {
  subjectId: 'hd-1',
  role: 'helpdesk',
  accountStatus: 'active',
  clinicianId: 'hd-1',
};
const VISITOR = {
  subjectId: 'vis-1',
  role: 'visitor',
  accountStatus: 'active',
  clinicianId: 'vis-1',
};

class InMemoryAppointmentStore implements AppointmentStore {
  readonly items: Appointment[] = [];

  async create(appointment: Appointment): Promise<void> {
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

  async listForClinicianCalendar(): Promise<Appointment[]> {
    return [];
  }

  async transition(
    patientId: string,
    scheduledAt: string,
    change: AppointmentTransition,
  ): Promise<Appointment> {
    const item = await this.get(patientId, scheduledAt);
    if (!item) {
      throw new AppError('RECORD_NOT_FOUND', 'no such appointment');
    }
    const updated = { ...item, appointment_status: change.to, updated_at: change.now };
    this.items[this.items.indexOf(item)] = updated;
    return updated;
  }
}

class InMemoryPatientNotificationStore implements PatientNotificationStore {
  readonly items: PatientNotification[] = [];

  async create(notification: PatientNotification): Promise<void> {
    this.items.push(notification);
  }

  async listForPatient(patientId: string): Promise<PatientNotification[]> {
    return this.items.filter((item) => item.patientId === patientId);
  }

  async markRead(): Promise<PatientNotification | undefined> {
    return undefined;
  }
}

function fakeEvent(overrides: {
  routeKey: string;
  pathParameters?: Record<string, string>;
  body?: unknown;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey,
    pathParameters: overrides.pathParameters,
    body: overrides.body === undefined ? undefined : JSON.stringify(overrides.body),
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : ASSIGNED_SUB },
    },
  } as unknown as LambdaAuthorizerEvent;
}

interface BuildOptions {
  readonly flagEnabled?: boolean;
  readonly tag?: 'IIC' | 'NDN';
  /** Skip instantiating the form, to exercise the lazy-instantiation path a pre-existing patient takes. */
  readonly withoutForm?: boolean;
}

async function build(overrides: BuildOptions = {}) {
  const patientStore = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  const patients = new PatientRepository(patientStore, audit, clock);
  await patients.register(
    {
      subjectId: 'pat-1',
      personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
      tag: overrides.tag ?? 'NDN',
    },
    SEED_ACTOR,
  );
  const existing = await patientStore.get('pat-1');
  if (existing) {
    await patientStore.put('pat-1', { ...existing, assigned_clinician_id: 'cli-1' });
  }

  const assessments = new AssessmentRepository(
    new InMemoryStore<Assessment>(),
    new InMemoryAuditLog(),
    clock,
  );
  if (!overrides.withoutForm) {
    await assessments.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, SEED_ACTOR, {
      tag: overrides.tag ?? 'NDN',
    });
  }

  const appointmentStore = new InMemoryAppointmentStore();
  const appointments = new AppointmentRepository(appointmentStore, new InMemoryAuditLog(), clock);

  const notificationStore = new InMemoryPatientNotificationStore();
  let seq = 0;
  const notifications = new PatientNotificationRepository(notificationStore, clock, {
    newId: () => `n${(seq += 1)}`,
  });

  const flagSource = new InMemoryFlagSource();
  flagSource.set('assessments.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const handler = createAssessmentHandler({
    patients,
    assessments,
    appointments,
    notifications,
    flags,
    clock,
  });
  return { handler, patients, assessments, appointmentStore, notificationStore };
}

async function invoke(
  handler: ReturnType<typeof createAssessmentHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const GET_ROUTE = 'GET /patients/{id}/assessments/{assessmentId}';
const POST_ROUTE = 'POST /patients/{id}/assessments/{assessmentId}';
const PATH = { id: 'pat-1', assessmentId: DEFAULT_ASSESSMENT_ID };

interface VersionShape {
  readonly version: number;
  readonly general?: { responses: Record<string, unknown>; attachments: unknown[] };
  readonly patient?: { responses: Record<string, unknown> };
  readonly private?: { responses: Record<string, unknown> };
  readonly calendar?: { responses: Record<string, unknown> };
}

interface GetBody {
  readonly currentVersion: number;
  readonly template: { fieldSet: string }[];
  readonly permissions: { fieldSet: string; read: boolean; write: boolean }[];
  readonly calendarSummary?: Record<string, unknown>;
  readonly items: VersionShape[];
}

function read(response: { body: string }): GetBody {
  return JSON.parse(response.body) as GetBody;
}

/** What this principal may write, according to the server's own answer. */
async function permissionsFor(
  handler: ReturnType<typeof createAssessmentHandler>,
  principal: Record<string, unknown>,
) {
  const response = await invoke(
    handler,
    fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal }),
  );
  return read(response).permissions;
}

/** Writes one section as `principal`, at whatever the current version is. */
async function write(
  handler: ReturnType<typeof createAssessmentHandler>,
  principal: Record<string, unknown>,
  sections: Record<string, unknown>,
  baseVersionOverride?: number,
) {
  const current =
    baseVersionOverride ??
    read(
      await invoke(handler, fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal })),
    ).currentVersion;
  return invoke(
    handler,
    fakeEvent({
      routeKey: POST_ROUTE,
      pathParameters: PATH,
      principal,
      body: { baseVersion: current, sections },
    }),
  );
}

describe('the four sections, and who may write each', () => {
  it('"the patient will be able to edit his general info only"', async () => {
    const { handler } = await build();
    const permissions = await permissionsFor(handler, OWNING_PATIENT);
    expect(permissions).toEqual([
      { fieldSet: 'general', read: true, write: true },
      { fieldSet: 'patient', read: true, write: false },
      { fieldSet: 'private', read: false, write: false },
      { fieldSet: 'calendar', read: true, write: false },
    ]);
  });

  it('"the helpdesk can only edit specific to the patient section as well as general section"', async () => {
    const { handler } = await build();
    expect(await permissionsFor(handler, HELPDESK)).toEqual([
      { fieldSet: 'general', read: true, write: true },
      { fieldSet: 'patient', read: true, write: true },
      { fieldSet: 'private', read: false, write: false },
      // Read-only, per "helpdesk/visitor/patient will only be able to read it".
      { fieldSet: 'calendar', read: true, write: false },
    ]);
  });

  it.each([
    ['the assigned clinician', ASSIGNED_SUB],
    ['the principal clinician', PRINCIPAL],
  ])('"the clinician/principal clinican can edit all the sections" — %s', async (_l, principal) => {
    const { handler } = await build();
    expect(await permissionsFor(handler, principal)).toEqual([
      { fieldSet: 'general', read: true, write: true },
      { fieldSet: 'patient', read: true, write: true },
      { fieldSet: 'private', read: true, write: true },
      { fieldSet: 'calendar', read: true, write: true },
    ]);
  });

  it('lets the patient write general info for real', async () => {
    const { handler } = await build();
    const response = await write(handler, OWNING_PATIENT, {
      general: { responses: { preferredName: 'Sam' } },
    });
    expect(response.statusCode).toBe(201);
    const after = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: OWNING_PATIENT }),
      ),
    );
    expect(after.items[0]?.general?.responses.preferredName).toBe('Sam');
  });

  it.each([
    ['the patient section', 'patient'],
    ['the clinician section', 'private'],
    ['the calendar section', 'calendar'],
  ])('is 403 when the patient tries to write %s', async (_label, fieldSet) => {
    const { handler } = await build();
    const response = await write(handler, OWNING_PATIENT, {
      [fieldSet]: { responses: {} },
    });
    expect(response.statusCode).toBe(403);
  });

  it('is 403 when helpdesk tries to write the clinician section', async () => {
    const { handler } = await build();
    expect(
      (await write(handler, HELPDESK, { private: { responses: { riskFlags: 'none' } } }))
        .statusCode,
    ).toBe(403);
  });

  it('is 403 when helpdesk tries to write the calendar section', async () => {
    const { handler } = await build();
    expect(
      (await write(handler, HELPDESK, { calendar: { responses: { schedulingNotes: 'x' } } }))
        .statusCode,
    ).toBe(403);
  });

  it('refuses the whole patch when any one named section is denied — a patch is never half-applied', async () => {
    const { handler } = await build();
    const response = await write(handler, HELPDESK, {
      general: { responses: { preferredName: 'Sam' } },
      private: { responses: { riskFlags: 'none' } },
    });
    expect(response.statusCode).toBe(403);
    const after = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: PRINCIPAL }),
      ),
    );
    // Still version 1: the permitted half of the patch did not land either.
    expect(after.currentVersion).toBe(1);
    expect(after.items[0]?.general?.responses.preferredName).toBeUndefined();
  });

  it('is 403 for an unassigned sub-clinician on every section, read and write', async () => {
    const { handler } = await build();
    const get = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: UNASSIGNED_SUB }),
    );
    expect(get.statusCode).toBe(403);
    expect((await write(handler, UNASSIGNED_SUB, { general: { responses: {} } }, 1)).statusCode).toBe(
      403,
    );
  });

  it('is 403 for a patient reaching another patient\'s form by a guessed id', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: OTHER_PATIENT }),
    );
    expect(response.statusCode).toBe(403);
  });
});

// R-09, the one Critical risk in docs/plan/02-risk-register.md. Asserted at
// the route, in every shape a response can take.
describe('R-09: a patient reaches no clinician-section field, in any relationship', () => {
  async function withPrivateNote() {
    const built = await build();
    const response = await write(built.handler, ASSIGNED_SUB, {
      private: { responses: { clinicianImpression: 'SECRET IMPRESSION' } },
    });
    expect(response.statusCode).toBe(201);
    return built;
  }

  it('omits the section from the patient\'s GET — the key is never on the object, not stripped from it', async () => {
    const { handler } = await withPrivateNote();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: OWNING_PATIENT }),
    );
    expect(response.body).not.toContain('SECRET IMPRESSION');
    expect(response.body).not.toContain('clinicianImpression');
    for (const item of read(response).items) {
      expect(Object.hasOwn(item, 'private')).toBe(false);
    }
  });

  it('omits it from the template and reports no read permission for it', async () => {
    const { handler } = await withPrivateNote();
    const body = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: OWNING_PATIENT }),
      ),
    );
    expect(body.template.map((section) => section.fieldSet)).toEqual([
      'general',
      'patient',
      'calendar',
    ]);
    expect(body.permissions.find((p) => p.fieldSet === 'private')).toEqual({
      fieldSet: 'private',
      read: false,
      write: false,
    });
  });

  it('omits it from the patient\'s own successful write response', async () => {
    const { handler } = await withPrivateNote();
    const response = await write(handler, OWNING_PATIENT, {
      general: { responses: { preferredName: 'Sam' } },
    });
    expect(response.statusCode).toBe(201);
    expect(response.body).not.toContain('SECRET IMPRESSION');
    const body = JSON.parse(response.body) as { item: VersionShape };
    expect(Object.hasOwn(body.item, 'private')).toBe(false);
  });

  it('omits it from helpdesk\'s view too — the boundary is the section, not the pool the account lives in', async () => {
    const { handler } = await withPrivateNote();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: HELPDESK }),
    );
    expect(response.body).not.toContain('SECRET IMPRESSION');
  });

  it('returns it to the clinician who wrote it, and to the principal', async () => {
    const { handler } = await withPrivateNote();
    for (const principal of [ASSIGNED_SUB, PRINCIPAL]) {
      const body = read(
        await invoke(
          handler,
          fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal }),
        ),
      );
      expect(body.items[0]?.private?.responses.clinicianImpression).toBe('SECRET IMPRESSION');
    }
  });
});

describe('the visitor — general info, IIC-tagged patients only', () => {
  it('reads the general and calendar sections of an IIC patient, and nothing else', async () => {
    const { handler } = await build({ tag: 'IIC' });
    const body = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: VISITOR }),
      ),
    );
    expect(body.permissions).toEqual([
      { fieldSet: 'general', read: true, write: false },
      { fieldSet: 'patient', read: false, write: false },
      { fieldSet: 'private', read: false, write: false },
      { fieldSet: 'calendar', read: true, write: false },
    ]);
    expect(body.template.map((s) => s.fieldSet)).toEqual(['general', 'calendar']);
  });

  it('is 404, not 403, for a patient outside their programme — a refusal must not confirm the patient exists', async () => {
    const { handler } = await build({ tag: 'NDN' });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: VISITOR }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 404 for an untagged record — absence is never read as membership', async () => {
    const { handler, patients } = await build({ tag: 'NDN' });
    // Written before tagging existed: the field is simply not there.
    const record = await patients.findById('pat-1');
    const untagged = { ...record! };
    delete (untagged as { tag?: string }).tag;
    await (patients as unknown as { store: InMemoryStore<Patient> }).store.put('pat-1', untagged);
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: VISITOR }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('writes nothing anywhere, even in their own programme', async () => {
    const { handler } = await build({ tag: 'IIC' });
    for (const fieldSet of ['general', 'patient', 'private', 'calendar']) {
      const response = await invoke(
        handler,
        fakeEvent({
          routeKey: POST_ROUTE,
          pathParameters: PATH,
          principal: VISITOR,
          body: { baseVersion: 1, sections: { [fieldSet]: { responses: {} } } },
        }),
      );
      expect(response.statusCode).toBe(403);
    }
  });
});

describe('the tag field — in the general section, but never the patient\'s to set', () => {
  it('is 403 when the patient writes it, even though they may write the section it lives in', async () => {
    const { handler } = await build();
    const response = await write(handler, OWNING_PATIENT, {
      general: { responses: { [ASSESSMENT_TAG_FIELD_ID]: 'IIC' } },
    });
    expect(response.statusCode).toBe(403);
  });

  it('does not let a patient smuggle it alongside a field they may write', async () => {
    const { handler, patients } = await build({ tag: 'NDN' });
    const response = await write(handler, OWNING_PATIENT, {
      general: { responses: { preferredName: 'Sam', [ASSESSMENT_TAG_FIELD_ID]: 'IIC' } },
    });
    expect(response.statusCode).toBe(403);
    expect((await patients.findById('pat-1'))?.tag).toBe('NDN');
  });

  it('writes through to Patient.tag when staff change it — the record stays the authority a visitor is filtered by', async () => {
    const { handler, patients } = await build({ tag: 'NDN' });
    const response = await write(handler, PRINCIPAL, {
      general: { responses: { [ASSESSMENT_TAG_FIELD_ID]: 'IIC' } },
    });
    expect(response.statusCode).toBe(201);
    expect((await patients.findById('pat-1'))?.tag).toBe('IIC');
  });

  it('is 400 for a value the template does not offer', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      general: { responses: { [ASSESSMENT_TAG_FIELD_ID]: 'SOMETHING-ELSE' } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the template is the schema', () => {
  it('is 400 for a field the template does not define — a clinical record is not a key/value store', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      general: { responses: { somethingInvented: 'x' } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'UNKNOWN_FIELD' });
  });

  it('is 400 for a derived calendar field — those are computed, never written', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      calendar: { responses: { sessionsCompleted: 99 } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'DERIVED_FIELD_NOT_WRITABLE' });
  });

  it('is 400 when a value is the wrong type for its field', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      patient: { responses: { consentToRecordSessions: 'yes please' } },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'INVALID_FIELD_TYPE' });
  });

  it('is 400 for a section name that is not one of the four', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: POST_ROUTE,
        pathParameters: PATH,
        principal: PRINCIPAL,
        body: { baseVersion: 1, sections: { billing: { responses: {} } } },
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 400 for a patch that names no section at all', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: POST_ROUTE,
        pathParameters: PATH,
        principal: PRINCIPAL,
        body: { baseVersion: 1, sections: {} },
      }),
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('attachments', () => {
  const key = `assessments/pat-1/${DEFAULT_ASSESSMENT_ID}/general/uuid-scan.pdf`;

  it('records one whose key is inside the section it is being filed under', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      general: {
        addAttachments: [{ key, fileName: 'scan.pdf', contentType: 'application/pdf' }],
      },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: VersionShape };
    expect(body.item.general?.attachments).toHaveLength(1);
  });

  it('is 400 for a key belonging to another section — an upload URL is not permission to file it anywhere', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      general: {
        addAttachments: [
          {
            key: `assessments/pat-1/${DEFAULT_ASSESSMENT_ID}/private/uuid-note.pdf`,
            fileName: 'note.pdf',
            contentType: 'application/pdf',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'ATTACHMENT_KEY_OUT_OF_SECTION' });
  });

  it('is 400 for a key belonging to another patient', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      general: {
        addAttachments: [
          {
            key: `assessments/pat-2/${DEFAULT_ASSESSMENT_ID}/general/uuid-scan.pdf`,
            fileName: 'scan.pdf',
            contentType: 'application/pdf',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('is 400 for a key that climbs out of its section with ..', async () => {
    const { handler } = await build();
    const response = await write(handler, PRINCIPAL, {
      general: {
        addAttachments: [
          {
            key: `assessments/pat-1/${DEFAULT_ASSESSMENT_ID}/general/../private/leak.pdf`,
            fileName: 'leak.pdf',
            contentType: 'application/pdf',
          },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the calendar section is derived, not stored', () => {
  async function withAppointments() {
    const built = await build();
    const clinician = actorContext(
      { subjectId: 'sub-1', role: 'sub-clinician' },
      { requestId: 'r', sourceIp: '198.51.100.2' },
    );
    const appointments = new AppointmentRepository(
      built.appointmentStore,
      new InMemoryAuditLog(),
      clock,
    );
    // Two completed sessions, one confirmed future one, one still pending,
    // and a later confirmed one that must not win "next".
    await appointments.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-07-01T10:00:00.000Z', durationMinutes: 30 },
      clinician,
      { requiresApproval: false },
    );
    await appointments.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-07-08T10:00:00.000Z', durationMinutes: 30 },
      clinician,
      { requiresApproval: false },
    );
    for (const at of ['2026-07-01T10:00:00.000Z', '2026-07-08T10:00:00.000Z']) {
      const item = built.appointmentStore.items.find((a) => a.scheduledAt === at);
      if (item) {
        built.appointmentStore.items[built.appointmentStore.items.indexOf(item)] = {
          ...item,
          appointment_status: 'completed',
        };
      }
    }
    await appointments.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-05T10:00:00.000Z', durationMinutes: 45 },
      clinician,
      { requiresApproval: false },
    );
    await appointments.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-09-20T10:00:00.000Z', durationMinutes: 60 },
      clinician,
      { requiresApproval: false },
    );
    await appointments.schedule(
      { patientId: 'pat-1', clinicianId: 'cli-1', scheduledAt: '2026-08-30T10:00:00.000Z', durationMinutes: 30 },
      clinician,
      { requiresApproval: true },
    );
    return built;
  }

  it('counts completed sessions and names the earliest confirmed future appointment', async () => {
    const { handler } = await withAppointments();
    const body = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: OWNING_PATIENT }),
      ),
    );
    expect(body.calendarSummary).toEqual({
      nextAppointmentAt: '2026-09-05T10:00:00.000Z',
      nextAppointmentDurationMinutes: 45,
      sessionsCompleted: 2,
      appointmentsAwaitingApproval: 1,
    });
  });

  it('never calls a pending-approval slot the next appointment — it is not one until the principal says so', async () => {
    const { handler } = await withAppointments();
    const body = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: OWNING_PATIENT }),
      ),
    );
    // 2026-08-30 is sooner than 2026-09-05, and is deliberately not chosen.
    expect(body.calendarSummary?.nextAppointmentAt).not.toBe('2026-08-30T10:00:00.000Z');
  });

  it('stores nothing derived on the record — a version carries only what was written', async () => {
    const { handler } = await withAppointments();
    const response = await write(handler, PRINCIPAL, {
      calendar: { responses: { schedulingNotes: 'mornings only' } },
    });
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: VersionShape };
    expect(body.item.calendar?.responses).toEqual({ schedulingNotes: 'mornings only' });
  });

  it('is absent for a caller who cannot read the calendar section', async () => {
    const { handler } = await build({ tag: 'NDN' });
    const body = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: UNASSIGNED_SUB }),
      ),
    );
    expect(body.calendarSummary).toBeUndefined();
  });
});

describe('a calendar edit notifies the patient', () => {
  it('writes one notice when a clinician edits the calendar section', async () => {
    const { handler, notificationStore } = await build();
    const response = await write(handler, PRINCIPAL, {
      calendar: { responses: { schedulingNotes: 'mornings only' } },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ notified: true });
    expect(notificationStore.items.map((n) => n.kind)).toEqual(['calendar-updated']);
  });

  it('writes none when a clinician edits a section that is not the calendar', async () => {
    const { handler, notificationStore } = await build();
    await write(handler, PRINCIPAL, { general: { responses: { preferredName: 'Sam' } } });
    expect(notificationStore.items).toHaveLength(0);
  });

  it('writes none when the patient edits their own general info — nobody needs telling about their own change', async () => {
    const { handler, notificationStore } = await build();
    await write(handler, OWNING_PATIENT, { general: { responses: { preferredName: 'Sam' } } });
    expect(notificationStore.items).toHaveLength(0);
  });

  it('still records the version when the feed write fails — and says so', async () => {
    const { handler, notificationStore } = await build();
    notificationStore.create = () => Promise.reject(new Error('dynamo is having a day'));
    const response = await write(handler, PRINCIPAL, {
      calendar: { responses: { schedulingNotes: 'x' } },
    });
    expect(response.statusCode).toBe(201);
    expect(JSON.parse(response.body)).toMatchObject({ notified: false });
  });
});

describe('versioning and concurrency', () => {
  it('is 409 when two writers both build on the same version', async () => {
    const { handler } = await build();
    const first = await write(handler, PRINCIPAL, {
      general: { responses: { preferredName: 'First' } },
    });
    expect(first.statusCode).toBe(201);
    // The second writer still thinks the form is at version 1.
    const second = await invoke(
      handler,
      fakeEvent({
        routeKey: POST_ROUTE,
        pathParameters: PATH,
        principal: PRINCIPAL,
        body: { baseVersion: 1, sections: { general: { responses: { preferredName: 'Second' } } } },
      }),
    );
    expect(second.statusCode).toBe(409);
    const after = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: PRINCIPAL }),
      ),
    );
    expect(after.items[0]?.general?.responses.preferredName).toBe('First');
  });

  it('returns versions newest-first', async () => {
    const { handler } = await build();
    await write(handler, PRINCIPAL, { general: { responses: { preferredName: 'Sam' } } });
    const body = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: PRINCIPAL }),
      ),
    );
    expect(body.items.map((item) => item.version)).toEqual([2, 1]);
    expect(body.currentVersion).toBe(2);
  });

  it('reports currentVersion 0 for a patient whose form predates the feature', async () => {
    const { handler } = await build({ withoutForm: true });
    const body = read(
      await invoke(
        handler,
        fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: PRINCIPAL }),
      ),
    );
    expect(body.currentVersion).toBe(0);
    expect(body.items).toEqual([]);
    // The template still renders — a fresh form and an empty form look the same.
    expect(body.template).toHaveLength(4);
  });

  it('instantiates lazily on the first write, seeding the tag from the patient record', async () => {
    const { handler, assessments } = await build({ withoutForm: true, tag: 'IIC' });
    const response = await write(handler, PRINCIPAL, {
      general: { responses: { preferredName: 'Sam' } },
    });
    expect(response.statusCode).toBe(201);
    const v1 = await assessments.getVersion('pat-1', DEFAULT_ASSESSMENT_ID, 1);
    expect(v1?.general.responses[ASSESSMENT_TAG_FIELD_ID]).toBe('IIC');
    const v2 = await assessments.getVersion('pat-1', DEFAULT_ASSESSMENT_ID, 2);
    expect(v2?.general.responses.preferredName).toBe('Sam');
  });

  it('is 409 when a caller claims there is no form but there is one', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: POST_ROUTE,
        pathParameters: PATH,
        principal: PRINCIPAL,
        body: { baseVersion: 0, sections: { general: { responses: {} } } },
      }),
    );
    expect(response.statusCode).toBe(409);
  });
});

describe('route plumbing', () => {
  it('resolves /patients/me to the calling patient', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: GET_ROUTE,
        pathParameters: { id: 'me', assessmentId: DEFAULT_ASSESSMENT_ID },
        principal: OWNING_PATIENT,
      }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: undefined }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE, pathParameters: PATH, principal: PRINCIPAL }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 404 for a patient record that does not exist — after authorisation, never before', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: GET_ROUTE,
        pathParameters: { id: 'pat-nobody', assessmentId: DEFAULT_ASSESSMENT_ID },
        principal: PRINCIPAL,
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 404 for an unknown route on this function', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'DELETE /patients/{id}', pathParameters: PATH, principal: PRINCIPAL }),
    );
    expect(response.statusCode).toBe(404);
  });
});

// The order of the two writes a tag change makes — the version, then the
// patient record — decides which way a half-failure errs. Asserted because
// the wrong order is over-permissive in exactly the case that actually
// happens (two staff editing at once).
describe('a failed version write never widens a visitor\'s reach', () => {
  it('leaves Patient.tag alone when the version write loses a 409 race', async () => {
    const { handler, patients } = await build({ tag: 'NDN' });
    // Land a version first, so the caller's `baseVersion: 1` is stale.
    await write(handler, PRINCIPAL, { general: { responses: { preferredName: 'First' } } });

    const stale = await invoke(
      handler,
      fakeEvent({
        routeKey: POST_ROUTE,
        pathParameters: PATH,
        principal: PRINCIPAL,
        body: {
          baseVersion: 1,
          sections: { general: { responses: { [ASSESSMENT_TAG_FIELD_ID]: 'IIC' } } },
        },
      }),
    );
    expect(stale.statusCode).toBe(409);
    // The record must not have moved: a visitor account reads `Patient.tag`,
    // and this write never landed.
    expect((await patients.findById('pat-1'))?.tag).toBe('NDN');
  });

  it('records the tag on the version as well as on the patient when the write does land', async () => {
    const { handler, patients, assessments } = await build({ tag: 'NDN' });
    const response = await write(handler, PRINCIPAL, {
      general: { responses: { [ASSESSMENT_TAG_FIELD_ID]: 'IIC' } },
    });
    expect(response.statusCode).toBe(201);
    expect((await patients.findById('pat-1'))?.tag).toBe('IIC');
    const latest = await assessments.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(latest?.general.responses[ASSESSMENT_TAG_FIELD_ID]).toBe('IIC');
  });
});
