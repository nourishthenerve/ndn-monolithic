import type { Assessment, Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { AssessmentRepository } from './assessment-repository.js';
import { createAssessmentHandler } from './assessment.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
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

  const assessments = new AssessmentRepository(
    new InMemoryStore<Assessment>(),
    new InMemoryAuditLog(),
    clock,
  );

  const flagSource = new InMemoryFlagSource();
  flagSource.set('assessments.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const handler = createAssessmentHandler({ patients, assessments, flags, clock });
  return { handler, patients, assessments };
}

async function invoke(
  handler: ReturnType<typeof createAssessmentHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const ROUTE_KEY = 'POST /patients/{id}/assessments/{assessmentId}';
const PATH_PARAMS = { id: 'pat-1', assessmentId: 'mobility-initial' };

describe('POST /patients/{id}/assessments/{assessmentId}', () => {
  it('creates version 1 for an assigned sub-clinician and echoes the private half back to its own author', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: {
          version: 1,
          visible: { formType: 'mobility', responses: { painScore: 4 } },
          private: { clinicianImpression: 'query non-organic presentation' },
        },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      item: {
        visible: { formType: string; responses: Record<string, unknown> };
        private?: { clinicianImpression: string };
      };
    };
    expect(body.item.visible.formType).toBe('mobility');
    expect(body.item.visible.responses).toEqual({ painScore: 4 });
    expect(body.item.private?.clinicianImpression).toBe('query non-organic presentation');
  });

  it('stores no private key at all when the caller supplies none, and the response echoes none', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: Record<string, unknown> };
    expect(Object.prototype.hasOwnProperty.call(body.item, 'private')).toBe(false);
  });

  it('lets version 2 of the same named form follow version 1', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: { painScore: 4 } } },
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 2, visible: { formType: 'mobility', responses: { painScore: 2 } } },
      }),
    );
    expect(response.statusCode).toBe(201);
  });

  it('keeps two different named forms for the same patient independent, even at the same version number', async () => {
    const { handler } = await build();
    const mobility = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: { id: 'pat-1', assessmentId: 'mobility-initial' },
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
      }),
    );
    const balance = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: { id: 'pat-1', assessmentId: 'balance-initial' },
        body: { version: 1, visible: { formType: 'balance', responses: {} } },
      }),
    );
    expect(mobility.statusCode).toBe(201);
    expect(balance.statusCode).toBe(201);
  });

  it('is 409, not a silent overwrite, when the version already exists for that named form', async () => {
    const { handler } = await build();
    await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: { sneaky: true } } },
      }),
    );
    expect(response.statusCode).toBe(409);
  });

  it('is 403 for the principal — unlike diagnosis/care-plan, only the assigned sub-clinician may author an assessment (authz-matrix.ts\'s own R-only Principal cell)', async () => {
    const { handler, assessments } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: {
          version: 1,
          visible: { formType: 'mobility', responses: {} },
          private: { clinicianImpression: 'principal note' },
        },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(assessments.getVersion('pat-1', 'mobility-initial', 1)).resolves.toBeUndefined();
  });

  it('is 403 for an unassigned sub-clinician, before any write', async () => {
    const { handler, assessments } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(assessments.getVersion('pat-1', 'mobility-initial', 1)).resolves.toBeUndefined();
  });

  it('is 403 for the owning patient, before any write — the row grants no create to the patient column', async () => {
    const { handler, assessments } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(assessments.getVersion('pat-1', 'mobility-initial', 1)).resolves.toBeUndefined();
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
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
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 400 with no id or assessmentId path parameter', async () => {
    const { handler } = await build();
    const noId = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: { assessmentId: 'mobility-initial' },
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
      }),
    );
    expect(noId.statusCode).toBe(400);

    const noAssessmentId = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: { id: 'pat-1' },
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
      }),
    );
    expect(noAssessmentId.statusCode).toBe(400);
  });

  it('is 400 for a missing visible{} or a missing version', async () => {
    const { handler } = await build();
    const missingVisible = await invoke(
      handler,
      fakeEvent({ routeKey: ROUTE_KEY, pathParameters: PATH_PARAMS, body: { version: 1 } }),
    );
    expect(missingVisible.statusCode).toBe(400);

    const missingVersion = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { visible: { formType: 'mobility', responses: {} } },
      }),
    );
    expect(missingVersion.statusCode).toBe(400);
  });

  it('is 400 for an unrecognised body field — a smuggled key fails the parse, not silently stripped', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: { version: 1, visible: { formType: 'mobility', responses: {} }, extra: 'nope' },
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 403, not 404, for the principal against a patient id that does not exist — the principal never reaches create on this row at all', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: { id: 'nobody', assessmentId: 'mobility-initial' },
        body: { version: 1, visible: { formType: 'mobility', responses: {} } },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
  });
});

const GET_ROUTE_KEY = 'GET /patients/{id}/assessments/{assessmentId}';

describe('GET /patients/{id}/assessments/{assessmentId}', () => {
  async function seedTwoVersions(handler: ReturnType<typeof createAssessmentHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: {
          version: 1,
          visible: { formType: 'mobility', responses: { painScore: 4 } },
          private: { clinicianImpression: 'query non-organic presentation' },
        },
      }),
    );
    await invoke(
      handler,
      fakeEvent({
        routeKey: ROUTE_KEY,
        pathParameters: PATH_PARAMS,
        body: {
          version: 2,
          visible: { formType: 'mobility', responses: { painScore: 2 } },
          private: { clinicianImpression: 'improving steadily' },
        },
      }),
    );
  }

  it(
    // The R-09 test, named as such: docs/plan/02-risk-register.md's own
    // register entry and authz.test.ts's own test name both point here.
    'a patient reading a version that carries a clinician impression finds no "private" key and no impression text anywhere in the raw serialised response',
    async () => {
      const { handler } = await build();
      await seedTwoVersions(handler);

      const response = await invoke(
        handler,
        fakeEvent({
          routeKey: GET_ROUTE_KEY,
          pathParameters: PATH_PARAMS,
          principal: OWNING_PATIENT_CONTEXT,
        }),
      );
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('private');
      expect(response.body).not.toContain('query non-organic presentation');
      expect(response.body).not.toContain('improving steadily');
      const body = JSON.parse(response.body) as {
        items: { version: number; visible: { responses: Record<string, unknown> } }[];
      };
      expect(body.items.map((item) => item.version)).toEqual([2, 1]);
    },
  );

  it('returns every version newest first, with the private half intact, for an assigned sub-clinician', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE_KEY, pathParameters: PATH_PARAMS }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      items: { version: number; private?: { clinicianImpression: string } }[];
    };
    expect(body.items.map((item) => item.version)).toEqual([2, 1]);
    expect(body.items[0]?.private?.clinicianImpression).toBe('improving steadily');
    expect(body.items[1]?.private?.clinicianImpression).toBe('query non-organic presentation');
  });

  it('returns every version with the private half intact for the principal', async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE_KEY, pathParameters: PATH_PARAMS, principal: PRINCIPAL_CONTEXT }),
    );
    const body = JSON.parse(response.body) as {
      items: { private?: { clinicianImpression: string } }[];
    };
    expect(body.items.every((item) => item.private !== undefined)).toBe(true);
  });

  it('returns an empty array, not a 404, when the named form has no history yet', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE_KEY, pathParameters: PATH_PARAMS, principal: OWNING_PATIENT_CONTEXT }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ items: [] });
  });

  it("is 403, never a 200 with a partial body, for a patient reading another patient's assessment by a guessed id", async () => {
    const { handler } = await build();
    await seedTwoVersions(handler);

    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: GET_ROUTE_KEY,
        pathParameters: PATH_PARAMS,
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
      fakeEvent({ routeKey: GET_ROUTE_KEY, pathParameters: PATH_PARAMS, principal: UNASSIGNED_SUB_CONTEXT }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE_KEY, pathParameters: PATH_PARAMS, principal: undefined }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: GET_ROUTE_KEY, pathParameters: PATH_PARAMS }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 404 for the principal against a patient id that does not exist — reachable here, unlike POST, because the principal does hold unconditional read', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: GET_ROUTE_KEY,
        pathParameters: { id: 'nobody', assessmentId: 'mobility-initial' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});
