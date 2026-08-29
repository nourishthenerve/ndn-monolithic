import type { Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import {
  createPatientAdminHandler,
  type AdminCreatePatientPort,
  type AdminFindPatientPort,
  type AdminSetPatientPasswordPort,
} from './patient-admin.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-29T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

function eventFor(
  routeKey: string,
  options: {
    readonly principal?: Record<string, unknown>;
    readonly pathParameters?: Record<string, string>;
    readonly queryStringParameters?: Record<string, string>;
    readonly body?: unknown;
  } = {},
): LambdaAuthorizerEvent {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/patients',
    rawQueryString: '',
    headers: {},
    pathParameters: options.pathParameters,
    queryStringParameters: options.queryStringParameters,
    body: options.body ? JSON.stringify(options.body) : undefined,
    isBase64Encoded: false,
    requestContext: {
      accountId: '',
      apiId: '',
      domainName: '',
      domainPrefix: '',
      http: {
        method: 'POST',
        path: '/patients',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.9',
        userAgent: '',
      },
      requestId: 'req-1',
      routeKey,
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: { lambda: options.principal },
    },
  } as unknown as LambdaAuthorizerEvent;
}

const PRINCIPAL_CONTEXT = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};

const SUB_CLINICIAN_CONTEXT = {
  subjectId: 'sub-sub',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'sub-sub',
};

const PATIENT_CONTEXT = {
  subjectId: 'patient-sub',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'patient-sub',
};

function build(overrides: { flagEnabled?: boolean; nextCreateResult?: 'created' | 'exists' } = {}) {
  const flagSource = new InMemoryFlagSource();
  flagSource.set('patients.administration.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const store = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  const repository = new PatientRepository(store, audit, clock);

  let nextSub = 0;
  const emailToSub = new Map<string, string>();
  const createPatientUser: AdminCreatePatientPort = {
    createUser: vi.fn(async (email: string) => {
      if (overrides.nextCreateResult === 'exists') {
        return { outcome: 'exists' } as const;
      }
      const subjectId = `sub-${(nextSub += 1)}`;
      emailToSub.set(email, subjectId);
      return { outcome: 'created', subjectId } as const;
    }),
  };

  const setPatientPassword: AdminSetPatientPasswordPort = {
    setPassword: vi.fn(async () => {}),
  };

  const findPatientUser: AdminFindPatientPort = {
    findByEmail: vi.fn(async (email: string) => {
      const subjectId = emailToSub.get(email);
      return subjectId ? { subjectId } : undefined;
    }),
  };

  const handler = createPatientAdminHandler({
    repository,
    flags,
    audit,
    createPatientUser,
    setPatientPassword,
    findPatientUser,
    generatePassword: () => 'Fixed-Passw0rd!',
    clock,
  });

  return { handler, repository, audit, createPatientUser, setPatientPassword, findPatientUser };
}

async function invoke(handler: ReturnType<typeof build>['handler'], event: LambdaAuthorizerEvent) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const VALID_BODY = {
  email: 'new-patient@example.com',
  fullName: 'New Patient',
  phone: '+919876543210',
  marketingOptIn: false,
};

describe('POST /patients', () => {
  it('404s when the flag is off', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('401s with no principal', async () => {
    const { handler } = build();
    const response = await invoke(handler, eventFor('POST /patients', { body: VALID_BODY }));
    expect(response.statusCode).toBe(401);
  });

  it.each([SUB_CLINICIAN_CONTEXT, PATIENT_CONTEXT])(
    '403s a non-principal caller',
    async (principal) => {
      const { handler } = build();
      const response = await invoke(
        handler,
        eventFor('POST /patients', { principal, body: VALID_BODY }),
      );
      expect(response.statusCode).toBe(403);
    },
  );

  it('400s an invalid body', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: { email: 'not-an-email' } }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('creates a Cognito user, sets a permanent password, then a pending patient record, in that order', async () => {
    const { handler, createPatientUser, setPatientPassword, repository } = build();

    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );

    expect(response.statusCode).toBe(201);
    expect(createPatientUser.createUser).toHaveBeenCalledWith('new-patient@example.com');
    expect(setPatientPassword.setPassword).toHaveBeenCalledWith('sub-1', 'Fixed-Passw0rd!');

    const body = JSON.parse(response.body) as {
      item: { id: string; account_status: string; personal: { fullName: string } };
      password: string;
    };
    expect(body.password).toBe('Fixed-Passw0rd!');
    expect(body.item.account_status).toBe('pending');
    expect(body.item.personal.fullName).toBe('New Patient');
    expect(await repository.findById(body.item.id)).toMatchObject({ account_status: 'pending' });
  });

  it('never reveals the generated password anywhere but this one response', async () => {
    // Structural proxy for "never logged, never persisted": the record
    // this test can actually inspect (the DynamoDB-shaped patient row) has
    // no field the password could have landed in.
    const { handler, repository } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    const body = JSON.parse(response.body) as { item: { id: string } };
    const stored = await repository.findById(body.item.id);
    expect(JSON.stringify(stored)).not.toContain('Fixed-Passw0rd!');
  });

  it('409s when the email already has a Cognito account', async () => {
    const { handler } = build({ nextCreateResult: 'exists' });
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    expect(response.statusCode).toBe(409);
  });
});

describe('POST /patients/{id}/reset-password', () => {
  async function createPatient(handler: ReturnType<typeof build>['handler']) {
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    return (JSON.parse(response.body) as { item: { id: string } }).item.id;
  }

  it('404s when the flag is off', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it.each([SUB_CLINICIAN_CONTEXT, PATIENT_CONTEXT])(
    '403s a non-principal caller',
    async (principal) => {
      const { handler } = build();
      const response = await invoke(
        handler,
        eventFor('POST /patients/{id}/reset-password', {
          principal,
          pathParameters: { id: 'pat-1' },
        }),
      );
      expect(response.statusCode).toBe(403);
    },
  );

  it('404s an unknown patient id', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'no-such-patient' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('sets a new permanent password and returns it once, with no repository write', async () => {
    const { handler, setPatientPassword, repository } = build();
    const id = await createPatient(handler);
    const before = await repository.findById(id);

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(setPatientPassword.setPassword).toHaveBeenLastCalledWith(id, 'Fixed-Passw0rd!');
    const body = JSON.parse(response.body) as { password: string };
    expect(body.password).toBe('Fixed-Passw0rd!');
    // No profile field changes — this action touches only the directory.
    expect(await repository.findById(id)).toEqual(before);
  });

  it('writes an audit row naming the acting principal', async () => {
    const { handler, audit } = build();
    const id = await createPatient(handler);

    await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id },
      }),
    );

    const events = audit.list();
    const resetEvent = events.find((event) => event.action === 'reset-password');
    expect(resetEvent).toMatchObject({
      actor: PRINCIPAL_CONTEXT.subjectId,
      entityType: 'patient',
      entityId: id,
    });
  });
});

describe('GET /patients', () => {
  async function createPatient(handler: ReturnType<typeof build>['handler']) {
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    return (JSON.parse(response.body) as { item: { id: string } }).item.id;
  }

  it('404s when the flag is off', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: VALID_BODY.email },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it.each([SUB_CLINICIAN_CONTEXT, PATIENT_CONTEXT])(
    '403s a non-principal caller',
    async (principal) => {
      const { handler } = build();
      const response = await invoke(
        handler,
        eventFor('GET /patients', { principal, queryStringParameters: { email: VALID_BODY.email } }),
      );
      expect(response.statusCode).toBe(403);
    },
  );

  it('400s a missing or invalid email query parameter', async () => {
    const { handler } = build();
    const missing = await invoke(handler, eventFor('GET /patients', { principal: PRINCIPAL_CONTEXT }));
    expect(missing.statusCode).toBe(400);

    const invalid = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: 'not-an-email' },
      }),
    );
    expect(invalid.statusCode).toBe(400);
  });

  it('404s an email with no matching account', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: 'nobody@example.com' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('finds a real patient by email and returns their full profile', async () => {
    const { handler, findPatientUser } = build();
    const id = await createPatient(handler);

    const response = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: VALID_BODY.email },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(findPatientUser.findByEmail).toHaveBeenCalledWith(VALID_BODY.email);
    const body = JSON.parse(response.body) as { item: { id: string; account_status: string } };
    expect(body.item.id).toBe(id);
    expect(body.item.account_status).toBe('pending');
  });
});
