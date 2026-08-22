import type { Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import { PatientRepository } from './patient-repository.js';
import { createPatientHandler } from './patient.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

const OWNER_ACTOR = actorContext(
  { subjectId: 'pat-1', role: 'patient' },
  { requestId: 'req-seed', sourceIp: '198.51.100.1' },
);

const OWNER_CONTEXT = {
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};

const OTHER_PATIENT_CONTEXT = {
  subjectId: 'pat-2',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-2',
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
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : OWNER_CONTEXT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

async function build(overrides: { flagEnabled?: boolean } = {}) {
  const store = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  const repository = new PatientRepository(store, audit, clock);
  await repository.register(
    {
      subjectId: 'pat-1',
      personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
    },
    OWNER_ACTOR,
  );

  const flagSource = new InMemoryFlagSource();
  flagSource.set('patients.profile.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const handler = createPatientHandler({ repository, flags, clock });
  return { handler, repository, store };
}

/**
 * `build()` plus `assigned_clinician_id` set directly on the store —
 * *how* a patient becomes assigned is `assignment-repository.ts`'s job
 * (TASK 2.5.1), not this file's; a direct store write is the same
 * shortcut `caseload-repository.test.ts`'s own fixtures already take for
 * the identical reason.
 */
async function buildAssigned(overrides: { flagEnabled?: boolean } = {}) {
  const built = await build(overrides);
  const existing = await built.store.get('pat-1');
  if (existing) {
    await built.store.put('pat-1', { ...existing, assigned_clinician_id: 'cli-1' });
  }
  return built;
}

async function invoke(handler: ReturnType<typeof createPatientHandler>, event: LambdaAuthorizerEvent) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

describe('GET /patients/{id}', () => {
  it('returns 200 with the record for the owning patient', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'GET /patients/{id}', pathParameters: { id: 'pat-1' } }),
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { item: { personal: { fullName: string } } };
    expect(body.item.personal.fullName).toBe('A Patient');
  });

  it('is 403 for another patient — a guessed id is denied, not looked up', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}',
        pathParameters: { id: 'pat-1' },
        principal: OTHER_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 403 for the same wrong-patient guess even against a nonexistent id — no distinguishable leak', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}',
        pathParameters: { id: 'nobody' },
        principal: OTHER_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('returns 200 for an assigned sub-clinician', async () => {
    const { handler } = await buildAssigned();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}',
        pathParameters: { id: 'pat-1' },
        principal: ASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('is 403 for an unassigned sub-clinician', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}',
        pathParameters: { id: 'pat-1' },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('returns 200 for the principal regardless of assignment', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'GET /patients/{id}',
        pathParameters: { id: 'pat-1' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'GET /patients/{id}', pathParameters: { id: 'pat-1' }, principal: undefined }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: 'GET /patients/{id}', pathParameters: { id: 'pat-1' } }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 400 with no id path parameter', async () => {
    const { handler } = await build();
    const response = await invoke(handler, fakeEvent({ routeKey: 'GET /patients/{id}' }));
    expect(response.statusCode).toBe(400);
  });
});

describe('PATCH /patients/{id} — a patient patching their own profile', () => {
  it('updates a personal field and returns 200', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'pat-1' },
        body: { personal: { phone: '07700900000' } },
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { item: { personal: { phone: string } } };
    expect(body.item.personal.phone).toBe('07700900000');
  });

  it('rejects a body containing clinical{} with 400, not a silent drop', async () => {
    const { handler, repository } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'pat-1' },
        body: { personal: { phone: '1' }, clinical: { referralSource: 'self-reported' } },
      }),
    );
    expect(response.statusCode).toBe(400);
    const found = await repository.findById('pat-1');
    expect(found?.clinical).toEqual({});
  });

  it('rejects an attempt to change email', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'pat-1' },
        body: { personal: { email: 'new@example.com' } },
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 403 patching another patient', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'pat-1' },
        principal: OTHER_PATIENT_CONTEXT,
        body: { personal: { phone: '1' } },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('rejects an empty patch with 400', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'pat-1' },
        body: { personal: {} },
      }),
    );
    expect(response.statusCode).toBe(400);
  });
});

describe('PATCH /patients/{id} — a clinician patching an assigned patient', () => {
  it('updates both personal{} and clinical{} in one call', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'pat-1' },
        principal: PRINCIPAL_CONTEXT,
        body: { personal: { phone: '1' }, clinical: { referralSource: 'GP' } },
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      item: { personal: { phone: string }; clinical: { referralSource: string } };
    };
    expect(body.item.personal.phone).toBe('1');
    expect(body.item.clinical.referralSource).toBe('GP');
  });

  it('is 403 for an unassigned sub-clinician', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'pat-1' },
        principal: UNASSIGNED_SUB_CONTEXT,
        body: { clinical: { referralSource: 'GP' } },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('returns 404 for an id that does not exist, once authorised', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: 'PATCH /patients/{id}',
        pathParameters: { id: 'missing' },
        principal: PRINCIPAL_CONTEXT,
        body: { personal: { phone: '1' } },
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('unknown route', () => {
  it('returns 404 for a routeKey it does not recognise', async () => {
    const { handler } = await build();
    const response = await invoke(handler, fakeEvent({ routeKey: 'DELETE /patients/{id}', pathParameters: { id: 'pat-1' } }));
    expect(response.statusCode).toBe(404);
  });
});
