import type { Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import { ClinicalRecordRepository } from './clinical-record-repository.js';
import { createClinicalRecordHandler } from './clinical-record.js';
import type { Clock } from './clock.js';
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

  const diagnosis = new ClinicalRecordRepository(
    new InMemoryStore(),
    new InMemoryAuditLog(),
    clock,
    'diagnosis',
  );
  const carePlan = new ClinicalRecordRepository(
    new InMemoryStore(),
    new InMemoryAuditLog(),
    clock,
    'care-plan',
  );

  const flagSource = new InMemoryFlagSource();
  flagSource.set('clinicalRecords.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const handler = createClinicalRecordHandler({ patients, diagnosis, carePlan, flags, clock });
  return { handler, patients, diagnosis, carePlan };
}

async function invoke(
  handler: ReturnType<typeof createClinicalRecordHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

describe('POST /patients/{id}/diagnosis', () => {
  it('creates version 1 for an assigned sub-clinician and echoes the private half back to its own author', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: {
          version: 1,
          visible: { summary: 'Chronic lower back pain' },
          private: { notes: 'query non-organic presentation' },
        },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      item: { visible: { summary: string }; private?: { notes: string } };
    };
    expect(body.item.visible.summary).toBe('Chronic lower back pain');
    expect(body.item.private?.notes).toBe('query non-organic presentation');
  });

  it('stores no private key at all when the caller supplies none, and the response echoes none', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Chronic lower back pain' } },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(body.item, 'private')).toBe(false);
  });

  it('lets version 2 follow version 1 for the same patient', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Initial' } },
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 2, visible: { summary: 'Revised' } },
      }),
    );
    expect(response.statusCode).toBe(201);
  });

  it('is 409, not a silent overwrite, when the version already exists', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Initial' } },
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Sneaky overwrite' } },
      }),
    );
    expect(response.statusCode).toBe(409);
  });

  it('creates for the principal regardless of assignment', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Initial' }, private: { notes: 'principal note' } },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: { private?: { notes: string } } };
    expect(body.item.private?.notes).toBe('principal note');
  });

  it('is 403 for an unassigned sub-clinician, before any write', async () => {
    const { handler, diagnosis } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Initial' } },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(diagnosis.getVersion('pat-1', 1)).resolves.toBeUndefined();
  });

  it('is 403 for the owning patient, before any write — the row grants bare R to the patient column', async () => {
    const { handler, diagnosis } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Initial' } },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(diagnosis.getVersion('pat-1', 1)).resolves.toBeUndefined();
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Initial' } },
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
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Initial' } },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 400 with no id path parameter', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'POST /patients/{id}/diagnosis', body: { version: 1, visible: { summary: 'x' } } }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 400 for a missing visible{} or a missing version', async () => {
    const { handler } = await build();
    const missingVisible = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1 },
      }),
    );
    expect(missingVisible.statusCode).toBe(400);

    const missingVersion = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { visible: { summary: 'x' } },
      }),
    );
    expect(missingVersion.statusCode).toBe(400);
  });

  it('is 400 for an unrecognised body field — a smuggled key fails the parse, not silently stripped', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'x' }, extra: 'nope' },
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 404 for the principal against a patient id that does not exist — the principal already has unrestricted caseload visibility', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'nobody' },
        body: { version: 1, visible: { summary: 'x' } },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /patients/{id}/diagnosis', () => {
  async function seedTwoVersions(handler: ReturnType<typeof createClinicalRecordHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: {
          version: 1,
          visible: { summary: 'Initial diagnosis' },
          private: { notes: 'first note' },
        },
      }),
    );
    await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: {
          version: 2,
          visible: { summary: 'Revised diagnosis' },
          private: { notes: 'second note' },
        },
      }),
    );
  }

  it('returns every version newest first, with the private half intact, for an assigned sub-clinician', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'GET /patients/{id}/diagnosis', pathParameters: { id: 'pat-1' } }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      items: { version: number; visible: { summary: string }; private?: { notes: string } }[];
    };
    expect(body.items.map((item) => item.version)).toEqual([2, 1]);
    expect(body.items[0]?.private?.notes).toBe('second note');
    expect(body.items[1]?.private?.notes).toBe('first note');
  });

  it('returns every version with the private half intact for the principal', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    const body = JSON.parse(response.body) as { items: { private?: { notes: string } }[] };
    expect(body.items.every((item) => item.private !== undefined)).toBe(true);
  });

  it('returns every version for the owning patient with zero occurrences of "private" at any depth', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private');
    const body = JSON.parse(response.body) as { items: { visible: { summary: string } }[] };
    expect(body.items.map((item) => item.visible.summary)).toEqual([
      'Revised diagnosis',
      'Initial diagnosis',
    ]);
  });

  it('returns an empty array, not a 404, when the patient has no diagnosis history yet', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [] });
  });

  it('is 403, never a 200 with an empty array, for a patient reading another patient\'s diagnosis by a guessed id', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        principal: { ...OWNING_PATIENT_CONTEXT, subjectId: 'pat-2', patientId: 'pat-2' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 403 for an unassigned sub-clinician', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        principal: undefined,
      }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'GET /patients/{id}/diagnosis', pathParameters: { id: 'pat-1' } }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('resolves /patients/me/diagnosis to the owning patient — the account page has no other way to learn its own id', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}/diagnosis',
        pathParameters: { id: 'me' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private');
    const body = JSON.parse(response.body) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });
});

describe('GET /patients/{id}/care-plan', () => {
  it('is kept fully independent of the diagnosis history', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/diagnosis',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Diagnosis only' } },
      }),
    );

    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'GET /patients/{id}/care-plan', pathParameters: { id: 'pat-1' } }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [] });
  });
});

describe('POST /patients/{id}/care-plan', () => {
  it('creates a version, kept fully independent of the diagnosis repository', async () => {
    const { handler, diagnosis } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/care-plan',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'Weekly physio, home exercises' } },
      }),
    );
    expect(response.statusCode).toBe(201);
    await expect(diagnosis.getVersion('pat-1', 1)).resolves.toBeUndefined();
  });

  it('is 403 for the owning patient', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'POST /patients/{id}/care-plan',
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { summary: 'x' } },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });
});
