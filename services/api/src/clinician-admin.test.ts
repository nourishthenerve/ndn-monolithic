import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import {
  createClinicianAdminHandler,
  type AdminCreateClinicianPort,
  type AdminDeactivateClinicianPort,
  type AdminReactivateClinicianPort,
} from './clinician-admin.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { InMemoryFlagSource, CachedFlagReader, FLAG_CACHE_TTL_MS } from './flags.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

function eventFor(
  routeKey: string,
  options: {
    readonly principal?: Record<string, unknown>;
    readonly pathParameters?: Record<string, string>;
    readonly body?: unknown;
  } = {},
): LambdaAuthorizerEvent {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/clinicians',
    rawQueryString: '',
    headers: {},
    pathParameters: options.pathParameters,
    body: options.body ? JSON.stringify(options.body) : undefined,
    isBase64Encoded: false,
    requestContext: {
      accountId: '',
      apiId: '',
      domainName: '',
      domainPrefix: '',
      http: { method: 'POST', path: '/clinicians', protocol: 'HTTP/1.1', sourceIp: '203.0.113.9', userAgent: '' },
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

function build(overrides: { flagEnabled?: boolean; password?: string } = {}) {
  const flagSource = new InMemoryFlagSource();
  flagSource.set('clinicians.administration.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const store = new InMemoryClinicianStore();
  const audit = new InMemoryAuditLog();
  const repository = new ClinicianRepository(store, audit, clock);

  let nextSub = 0;
  const createClinicianUser: AdminCreateClinicianPort = {
    createUser: vi.fn(async () => `sub-${(nextSub += 1)}`),
    addToPrincipalGroup: vi.fn(async () => {}),
    setPassword: vi.fn(async () => {}),
    provisionTotp: vi.fn(async () => ({
      secret: 'JBSWY3DPEHPK3PXP',
      otpauthUri: 'otpauth://totp/Nourish%20the%20Nerve:test@example.com?secret=JBSWY3DPEHPK3PXP',
    })),
  };

  const deactivateClinicianUser: AdminDeactivateClinicianPort = {
    disable: vi.fn(async () => {}),
    revokeTokens: vi.fn(async () => {}),
  };

  const reactivateClinicianUser: AdminReactivateClinicianPort = {
    enable: vi.fn(async () => {}),
  };

  const handler = createClinicianAdminHandler({
    repository,
    flags,
    createClinicianUser,
    deactivateClinicianUser,
    reactivateClinicianUser,
    clock,
    generatePassword: vi.fn(() => overrides.password ?? 'Gen3rat3d!Pass'),
  });

  return {
    handler,
    repository,
    audit,
    createClinicianUser,
    deactivateClinicianUser,
    reactivateClinicianUser,
  };
}

async function invoke(handler: ReturnType<typeof build>['handler'], event: LambdaAuthorizerEvent) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

describe('POST /clinicians', () => {
  it('creates a Cognito user then a clinician record, in that order, and returns 201', async () => {
    const { handler, createClinicianUser, repository } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'new@example.com', displayName: 'New Clinician', role: 'sub' },
      }),
    );

    expect(response.statusCode).toBe(201);
    expect(createClinicianUser.createUser).toHaveBeenCalledWith('new@example.com');
    const body = JSON.parse(response.body) as { item: { id: string; role: string } };
    expect(body.item.role).toBe('sub');
    expect(await repository.findById(body.item.id)).toMatchObject({ displayName: 'New Clinician' });
  });

  it('D-30: sets a permanent password and provisions TOTP, returning both once — no invite email involved', async () => {
    const { handler, createClinicianUser } = build({ password: 'Str0ng!Passw0rd' });

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'new@example.com', displayName: 'New Clinician', role: 'sub' },
      }),
    );

    const body = JSON.parse(response.body) as {
      item: { id: string };
      password: string;
      totpSecret: string;
      otpauthUri: string;
    };
    expect(createClinicianUser.setPassword).toHaveBeenCalledWith(body.item.id, 'Str0ng!Passw0rd');
    expect(createClinicianUser.provisionTotp).toHaveBeenCalledWith(
      body.item.id,
      'new@example.com',
      'Str0ng!Passw0rd',
    );
    expect(body.password).toBe('Str0ng!Passw0rd');
    expect(body.totpSecret).toBe('JBSWY3DPEHPK3PXP');
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
  });

  // Amendment, 2026-08-31: the pool's `mfa` is `OPTIONAL`, not `REQUIRED`
  // — `provisionTotp` returns `undefined` when Cognito completes
  // sign-in with no MFA_SETUP challenge (auth-stack.ts/clinician-admin-handler.ts's
  // own headers on why). The response must omit rather than error on it.
  it('D-30 amendment: omits totpSecret/otpauthUri when nothing was provisioned', async () => {
    const { handler, createClinicianUser } = build({ password: 'Str0ng!Passw0rd' });
    createClinicianUser.provisionTotp = vi.fn(async () => undefined);

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'new@example.com', displayName: 'New Clinician', role: 'sub' },
      }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as {
      item: { id: string };
      password: string;
      totpSecret?: string;
      otpauthUri?: string;
    };
    expect(body.password).toBe('Str0ng!Passw0rd');
    expect(body).not.toHaveProperty('totpSecret');
    expect(body).not.toHaveProperty('otpauthUri');
  });

  it('D-30: Cognito artefacts are provisioned before the CLI# record is written, in order', async () => {
    const { handler, createClinicianUser, repository } = build();
    const order: string[] = [];
    createClinicianUser.createUser = vi.fn(async () => {
      order.push('createUser');
      return 'sub-ordered';
    });
    createClinicianUser.setPassword = vi.fn(async () => {
      order.push('setPassword');
    });
    createClinicianUser.provisionTotp = vi.fn(async () => {
      order.push('provisionTotp');
      return { secret: 's', otpauthUri: 'otpauth://totp/x' };
    });
    const originalCreate = repository.create.bind(repository);
    repository.create = vi.fn(async (...args: Parameters<typeof originalCreate>) => {
      order.push('repository.create');
      return originalCreate(...args);
    });

    await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'ordered@example.com', displayName: 'Ordered', role: 'sub' },
      }),
    );

    expect(order).toEqual(['createUser', 'setPassword', 'provisionTotp', 'repository.create']);
  });

  it('D-30: a rejected record write never surfaces the password or TOTP secret to the caller', async () => {
    const { handler, createClinicianUser } = build();
    await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'first@example.com', displayName: 'First', role: 'principal' },
      }),
    );

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'second@example.com', displayName: 'Second', role: 'principal' },
      }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.body).not.toMatch(/password/i);
    expect(response.body).not.toMatch(/totp/i);
    // Still called for the second (rejected) attempt too — this is the
    // orphaned-Cognito-user failure mode this task's own header accepts,
    // not a leak: the secret exists in Cognito but is never returned to
    // anyone, so nobody — including this test — can ever learn it.
    expect(createClinicianUser.provisionTotp).toHaveBeenCalledTimes(2);
  });

  it('never adds a sub-clinician to the principal Cognito group', async () => {
    const { handler, createClinicianUser } = build();

    await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'new@example.com', displayName: 'New Clinician', role: 'sub' },
      }),
    );

    expect(createClinicianUser.addToPrincipalGroup).not.toHaveBeenCalled();
  });

  it('adds a newly-created principal to the principal Cognito group, only after the record is accepted', async () => {
    const { handler, createClinicianUser } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'first@example.com', displayName: 'First', role: 'principal' },
      }),
    );

    const body = JSON.parse(response.body) as { item: { id: string } };
    expect(createClinicianUser.addToPrincipalGroup).toHaveBeenCalledWith(body.item.id);
    expect(createClinicianUser.addToPrincipalGroup).toHaveBeenCalledTimes(1);
  });

  it('is 409 for a second principal and never grants that second attempt the group', async () => {
    const { handler, createClinicianUser } = build();
    await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'first@example.com', displayName: 'First', role: 'principal' },
      }),
    );

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'second@example.com', displayName: 'Second', role: 'principal' },
      }),
    );

    expect(response.statusCode).toBe(409);
    // Exactly once total across both attempts — the first (accepted)
    // creation grants it, the second (rejected, 409) never does.
    expect(createClinicianUser.addToPrincipalGroup).toHaveBeenCalledTimes(1);
  });

  it('is 403 for a sub-clinician caller', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: SUB_CLINICIAN_CONTEXT,
        body: { email: 'x@example.com', displayName: 'X', role: 'sub' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 403 for a patient caller', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PATIENT_CONTEXT,
        body: { email: 'x@example.com', displayName: 'X', role: 'sub' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        body: { email: 'x@example.com', displayName: 'X', role: 'sub' },
      }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off, even for the principal', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'x@example.com', displayName: 'X', role: 'sub' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 400 for an invalid body, and never calls Cognito', async () => {
    const { handler, createClinicianUser } = build();
    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'not-an-email', displayName: '', role: 'sub' },
      }),
    );
    expect(response.statusCode).toBe(400);
    expect(createClinicianUser.createUser).not.toHaveBeenCalled();
  });

  it('is 409 when a second principal is created', async () => {
    const { handler } = build();
    await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'first@example.com', displayName: 'First', role: 'principal' },
      }),
    );
    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'second@example.com', displayName: 'Second', role: 'principal' },
      }),
    );
    expect(response.statusCode).toBe(409);
  });
});

describe('POST /clinicians/{id}/deactivate', () => {
  it('deactivates the record, disables the Cognito user and revokes tokens — all three', async () => {
    const { handler, deactivateClinicianUser, repository } = build();
    await repository.create(
      'sub-1',
      { displayName: 'A', role: 'sub' },
      { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
    );

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/{id}/deactivate', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'sub-1' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect((await repository.findById('sub-1'))?.account_status).toBe('deactivated');
    expect(deactivateClinicianUser.disable).toHaveBeenCalledWith('sub-1');
    expect(deactivateClinicianUser.revokeTokens).toHaveBeenCalledWith('sub-1');
  });

  it('is 403 for a sub-clinician caller', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /clinicians/{id}/deactivate', {
        principal: SUB_CLINICIAN_CONTEXT,
        pathParameters: { id: 'sub-1' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 404 for an id that was never created', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /clinicians/{id}/deactivate', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'nope' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /clinicians/{id}/reactivate', () => {
  it('reactivates the record and enables the Cognito user', async () => {
    const { handler, repository, reactivateClinicianUser } = build();
    await repository.create(
      'sub-1',
      { displayName: 'A', role: 'sub' },
      { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
    );
    await repository.deactivate('sub-1', {
      subjectId: 'principal-sub',
      role: 'principal-clinician',
      requestId: 'r',
      sourceIpHash: 'h',
    });

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/{id}/reactivate', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'sub-1' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect((await repository.findById('sub-1'))?.account_status).toBe('active');
    expect(reactivateClinicianUser.enable).toHaveBeenCalledWith('sub-1');
  });
});
