import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import {
  createClinicianAdminHandler,
  type AdminCreateClinicianPort,
  type AdminDeactivateClinicianPort,
  type AdminReactivateClinicianPort,
  type ChangeOwnPasswordPort,
} from './clinician-admin.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
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
    readonly headers?: Record<string, string>;
  } = {},
): LambdaAuthorizerEvent {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/clinicians',
    rawQueryString: '',
    headers: options.headers ?? {},
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

const HELPDESK_CONTEXT = {
  subjectId: 'helpdesk-sub',
  role: 'helpdesk',
  accountStatus: 'active',
  clinicianId: 'helpdesk-sub',
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
    addToGroup: vi.fn(async () => {}),
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

  const changeOwnPassword: ChangeOwnPasswordPort = {
    changePassword: vi.fn(async () => {}),
  };

  const handler = createClinicianAdminHandler({
    repository,
    flags,
    createClinicianUser,
    deactivateClinicianUser,
    reactivateClinicianUser,
    changeOwnPassword,
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
    changeOwnPassword,
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

    expect(createClinicianUser.addToGroup).not.toHaveBeenCalled();
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
    expect(createClinicianUser.addToGroup).toHaveBeenCalledWith(body.item.id, 'principal-clinician');
    expect(createClinicianUser.addToGroup).toHaveBeenCalledTimes(1);
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
    expect(createClinicianUser.addToGroup).toHaveBeenCalledTimes(1);
  });

  // 2026-08-31: the third role. The record and the Cognito group have to
  // agree, because `roleFor()` reads only the group — a `CLI#` row saying
  // `helpdesk` with no group membership behind it is a sub-clinician in
  // every decision that matters, which is exactly the bug found live on
  // 2026-08-28 for the principal role.
  it('creates a helpdesk account and grants it the helpdesk group', async () => {
    const { handler, createClinicianUser, repository } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'desk@example.com', displayName: 'Front Desk', role: 'helpdesk' },
      }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: { id: string; role: string } };
    expect(body.item.role).toBe('helpdesk');
    expect(await repository.findById(body.item.id)).toMatchObject({ role: 'helpdesk' });
    expect(createClinicianUser.addToGroup).toHaveBeenCalledWith(body.item.id, 'helpdesk');
  });

  it('allows many helpdesk accounts — the singleton invariant is the principal role’s alone', async () => {
    const { handler } = build();

    for (const email of ['desk1@example.com', 'desk2@example.com', 'desk3@example.com']) {
      const response = await invoke(
        handler,
        eventFor('POST /clinicians', {
          principal: PRINCIPAL_CONTEXT,
          body: { email, displayName: 'Front Desk', role: 'helpdesk' },
        }),
      );
      expect(response.statusCode).toBe(201);
    }
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

  // 2026-08-31: the principal may set a colleague's first password.
  it('uses a principal-chosen password instead of generating one', async () => {
    const { handler, createClinicianUser } = build({ password: 'Gen3rat3d!Pass' });

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: {
          email: 'new@example.com',
          displayName: 'New Clinician',
          role: 'sub',
          password: 'Ch0sen!ByPrincipal',
        },
      }),
    );

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: { id: string }; password: string };
    expect(createClinicianUser.setPassword).toHaveBeenCalledWith(body.item.id, 'Ch0sen!ByPrincipal');
    // Still echoed back once, exactly as a generated one is — the
    // principal is relaying it over WhatsApp either way, and the response
    // is the only place it ever appears on this side.
    expect(body.password).toBe('Ch0sen!ByPrincipal');
  });

  it('falls back to the generated password when the field is absent', async () => {
    const { handler, createClinicianUser } = build({ password: 'Gen3rat3d!Pass' });

    await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'new@example.com', displayName: 'New Clinician', role: 'sub' },
      }),
    );

    expect(createClinicianUser.setPassword).toHaveBeenCalledWith(
      expect.any(String),
      'Gen3rat3d!Pass',
    );
  });

  it('returns 400, not 500, when Cognito rejects a chosen password', async () => {
    const { handler, createClinicianUser } = build();
    vi.mocked(createClinicianUser.setPassword).mockRejectedValueOnce(
      new AppError('PASSWORD_POLICY_VIOLATION', 'rejected'),
    );

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'new@example.com', displayName: 'New', role: 'sub', password: 'weakpass' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'PASSWORD_POLICY_VIOLATION' });
  });

  it('returns 409, not 500, when the email already has a Cognito account', async () => {
    const { handler, createClinicianUser } = build();
    vi.mocked(createClinicianUser.createUser).mockRejectedValueOnce(
      new AppError('COGNITO_ACCOUNT_ALREADY_EXISTS', 'exists'),
    );

    const response = await invoke(
      handler,
      eventFor('POST /clinicians', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'taken@example.com', displayName: 'New', role: 'sub' },
      }),
    );

    expect(response.statusCode).toBe(409);
  });
});

// 2026-08-31: the directory read the dashboard and this page's own
// deactivate control both depend on.
describe('GET /clinicians', () => {
  async function seed(repository: ReturnType<typeof build>['repository']) {
    const actor = {
      subjectId: 'principal-sub',
      role: 'principal-clinician' as const,
      requestId: 'r',
      sourceIpHash: 'h',
    };
    await repository.create('cli-1', { displayName: 'Active One', role: 'sub' }, actor);
    await repository.create('cli-2', { displayName: 'Gone One', role: 'sub' }, actor);
    await repository.deactivate('cli-2', actor);
  }

  it('returns every clinician to the principal, deactivated ones included', async () => {
    const { handler, repository } = build();
    await seed(repository);

    const response = await invoke(
      handler,
      eventFor('GET /clinicians', { principal: PRINCIPAL_CONTEXT }),
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      items: { id: string; displayName: string; account_status: string }[];
    };
    expect(body.items).toEqual([
      expect.objectContaining({ id: 'cli-1', account_status: 'active' }),
      // Deactivated, and still listed — the principal has to see them to
      // restore their access.
      expect.objectContaining({ id: 'cli-2', account_status: 'deactivated' }),
    ]);
  });

  it.each([
    ['a sub-clinician', SUB_CLINICIAN_CONTEXT],
    ['a patient', PATIENT_CONTEXT],
  ])('refuses %s with 403 — the clinician directory is Principal-only', async (_label, principal) => {
    const { handler, repository } = build();
    await seed(repository);

    const response = await invoke(handler, eventFor('GET /clinicians', { principal }));

    expect(response.statusCode).toBe(403);
  });

  it('is 404 when the flag is off, like every other route on this handler', async () => {
    const { handler } = build({ flagEnabled: false });

    const response = await invoke(
      handler,
      eventFor('GET /clinicians', { principal: PRINCIPAL_CONTEXT }),
    );

    expect(response.statusCode).toBe(404);
  });
});

// 2026-08-31: the `Own profile` row's first endpoint. Every signed-in
// clinician role holds `R U` there; a patient holds it only on their
// *own* profile, which this route is not.
describe('GET/PATCH /clinicians/me', () => {
  async function seedSelf(repository: ReturnType<typeof build>['repository'], id: string, role: 'principal' | 'sub' | 'helpdesk' = 'sub') {
    await repository.create(
      id,
      { displayName: 'Before', role },
      { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
    );
  }

  it.each([
    ['a sub-clinician', SUB_CLINICIAN_CONTEXT, 'sub-sub'],
    ['the principal', PRINCIPAL_CONTEXT, 'principal-sub'],
    ['a helpdesk account', HELPDESK_CONTEXT, 'helpdesk-sub'],
  ])('lets %s rename themselves', async (_label, principal, id) => {
    const { handler, repository } = build();
    await seedSelf(repository, id, id === 'principal-sub' ? 'principal' : 'sub');

    const response = await invoke(
      handler,
      eventFor('PATCH /clinicians/me', { principal, body: { displayName: 'After' } }),
    );

    expect(response.statusCode).toBe(200);
    expect(await repository.findById(id)).toMatchObject({ displayName: 'After' });
  });

  it('never lets a rename change role or account status', async () => {
    const { handler, repository } = build();
    await seedSelf(repository, 'sub-sub', 'sub');

    await invoke(
      handler,
      eventFor('PATCH /clinicians/me', {
        principal: SUB_CLINICIAN_CONTEXT,
        // Both fields are ignored by the schema, not merged — the record
        // below is what proves it, not the absence of a type error.
        body: { displayName: 'After', role: 'principal', account_status: 'deactivated' },
      }),
    );

    expect(await repository.findById('sub-sub')).toMatchObject({
      displayName: 'After',
      role: 'sub',
      account_status: 'active',
    });
  });

  it('refuses a patient — they have no clinician record and land in Patient (other)', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('PATCH /clinicians/me', {
        principal: PATIENT_CONTEXT,
        body: { displayName: 'Nice Try' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('400s a blank display name rather than storing one', async () => {
    const { handler, repository } = build();
    await seedSelf(repository, 'sub-sub', 'sub');
    const response = await invoke(
      handler,
      eventFor('PATCH /clinicians/me', { principal: SUB_CLINICIAN_CONTEXT, body: { displayName: '' } }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('GET returns the caller\'s own record, and 404s when they have none', async () => {
    const { handler, repository } = build();
    const missing = await invoke(
      handler,
      eventFor('GET /clinicians/me', { principal: SUB_CLINICIAN_CONTEXT }),
    );
    expect(missing.statusCode).toBe(404);

    await seedSelf(repository, 'sub-sub', 'sub');
    const found = await invoke(
      handler,
      eventFor('GET /clinicians/me', { principal: SUB_CLINICIAN_CONTEXT }),
    );
    expect(found.statusCode).toBe(200);
    expect((JSON.parse(found.body) as { item: { id: string } }).item.id).toBe('sub-sub');
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

describe('POST /clinicians/me/change-password (D-34)', () => {
  it('changes the password for a signed-in sub-clinician, using the bearer token as the access token', async () => {
    const { handler, changeOwnPassword } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/me/change-password', {
        principal: SUB_CLINICIAN_CONTEXT,
        headers: { authorization: 'Bearer real-access-token' },
        body: { currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(changeOwnPassword.changePassword).toHaveBeenCalledWith(
      'real-access-token',
      'OldPassw0rd!',
      'NewPassw0rd!',
    );
  });

  it('changes the password for the principal too — clinician-only, not principal-only', async () => {
    const { handler, changeOwnPassword } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/me/change-password', {
        principal: PRINCIPAL_CONTEXT,
        headers: { authorization: 'Bearer principal-token' },
        body: { currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(changeOwnPassword.changePassword).toHaveBeenCalled();
  });

  // Rewritten 2026-08-31, not deleted. This test used to assert the
  // opposite — "D-29: denies a patient" — and the owner's own report is
  // why it flipped: *"patient after logged in doesnt have access to
  // update his password."*
  //
  // D-29's boundary is not this route. Password *reset* — "I have
  // forgotten it, let me back in" — is an identity-verification act, and
  // it is still staff-only over WhatsApp with no recovery flow, no email
  // link and no OTP (`POST /patients/{id}/reset-password`, Principal and
  // Helpdesk only). A password *change* proves the current password to
  // Cognito itself, so whoever can do it already holds the credential:
  // it verifies no identity because it needs none. Refusing it only left
  // a patient unable to replace a password that staff had read aloud
  // over WhatsApp.
  it('lets a patient change their own password — reset stays staff-only, change never needed to be', async () => {
    const { handler, changeOwnPassword } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/me/change-password', {
        principal: PATIENT_CONTEXT,
        headers: { authorization: 'Bearer patient-token' },
        body: { currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!' },
      }),
    );

    expect(response.statusCode).toBe(200);
    // Cognito is handed the caller's own token and their own current
    // password — it, not this codebase, is what actually decides.
    expect(changeOwnPassword.changePassword).toHaveBeenCalledWith(
      'patient-token',
      'OldPassw0rd!',
      'NewPassw0rd!',
    );
  });

  it('rejects a missing bearer token as unauthorized, without calling Cognito', async () => {
    const { handler, changeOwnPassword } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/me/change-password', {
        principal: SUB_CLINICIAN_CONTEXT,
        body: { currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!' },
      }),
    );

    expect(response.statusCode).toBe(401);
    expect(changeOwnPassword.changePassword).not.toHaveBeenCalled();
  });

  it('rejects a malformed body as 400, without calling Cognito', async () => {
    const { handler, changeOwnPassword } = build();

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/me/change-password', {
        principal: SUB_CLINICIAN_CONTEXT,
        headers: { authorization: 'Bearer t' },
        body: { currentPassword: '' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(changeOwnPassword.changePassword).not.toHaveBeenCalled();
  });

  it('surfaces an incorrect current password as 400 INCORRECT_CURRENT_PASSWORD', async () => {
    const { handler, changeOwnPassword } = build();
    changeOwnPassword.changePassword = vi.fn(async () => {
      throw new AppError('INCORRECT_CURRENT_PASSWORD', 'ChangePassword: not authorized');
    });

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/me/change-password', {
        principal: SUB_CLINICIAN_CONTEXT,
        headers: { authorization: 'Bearer t' },
        body: { currentPassword: 'Wrong1!', newPassword: 'NewPassw0rd!' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'INCORRECT_CURRENT_PASSWORD' });
  });

  it('surfaces a rejected new password as 400 PASSWORD_POLICY_VIOLATION', async () => {
    const { handler, changeOwnPassword } = build();
    changeOwnPassword.changePassword = vi.fn(async () => {
      throw new AppError('PASSWORD_POLICY_VIOLATION', 'ChangePassword: new password rejected');
    });

    const response = await invoke(
      handler,
      eventFor('POST /clinicians/me/change-password', {
        principal: SUB_CLINICIAN_CONTEXT,
        headers: { authorization: 'Bearer t' },
        body: { currentPassword: 'OldPassw0rd!', newPassword: 'weak' },
      }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: 'PASSWORD_POLICY_VIOLATION' });
  });
});
