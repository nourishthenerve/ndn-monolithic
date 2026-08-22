import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { AssignmentRepository, InMemoryAssignmentStore } from './assignment-repository.js';
import { createAssignmentHandler } from './assignment.js';
import { InMemoryAuditLog } from './audit.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import { InMemoryDeliveryLog } from './notification-log.js';
import { createNotifier, type EmailSend } from './notifications.js';
import { InMemoryStore } from './store.js';

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
    rawPath: '/patients',
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
      http: { method: 'POST', path: '/patients', protocol: 'HTTP/1.1', sourceIp: '203.0.113.9', userAgent: '' },
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
  subjectId: 'pat-1',
  role: 'patient',
  accountStatus: 'pending',
  patientId: 'pat-1',
};

async function build(overrides: { flagEnabled?: boolean } = {}) {
  const flagSource = new InMemoryFlagSource();
  flagSource.set('assignment.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const patientStore = new InMemoryStore<import('@ndn/shared-types').Patient>();
  await patientStore.put('pat-1', {
    id: 'pat-1',
    personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
    clinical: {},
    account_status: 'pending',
    keywords: [],
    status: 'active',
    created_at: '2026-08-22T08:00:00.000Z',
    updated_at: '2026-08-22T08:00:00.000Z',
  });

  const clinicianStore = new InMemoryClinicianStore();
  const clinicians = new ClinicianRepository(clinicianStore, new InMemoryAuditLog(), clock);
  await clinicians.create(
    'cli-1',
    { displayName: 'A Clinician', role: 'sub' },
    { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
  );

  const assignmentStore = new InMemoryAssignmentStore(patientStore);
  const repository = new AssignmentRepository(assignmentStore, clinicians, new InMemoryAuditLog(), clock);

  const sendEmail: EmailSend = vi.fn(async () => {});
  const deliveryLog = new InMemoryDeliveryLog();
  const notifier = createNotifier({
    sendEmail,
    sendSms: vi.fn(async () => ({ ok: true, status: 'Sent' }) as const),
    log: deliveryLog,
    clock,
  });

  const getClinicianEmail = { getEmail: vi.fn(async () => 'clinician@example.com') };

  const handler = createAssignmentHandler({ repository, flags, notifier, getClinicianEmail, clock });

  return { handler, patientStore, clinicians, repository, sendEmail, getClinicianEmail, deliveryLog };
}

async function invoke(handler: Awaited<ReturnType<typeof build>>['handler'], event: LambdaAuthorizerEvent) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

describe('POST /patients/{id}/approve', () => {
  it('approves and returns 200 with the assignment request', async () => {
    const { handler } = await build();

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { item: { status: string; assignedClinicianId: string } };
    expect(body.item.status).toBe('approved');
    expect(body.item.assignedClinicianId).toBe('cli-1');
  });

  it('sends the patientApproved notification', async () => {
    const { handler, sendEmail } = await build();
    await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('is 403 for a sub-clinician caller — only the principal ever assigns', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: SUB_CLINICIAN_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 403 for a patient caller, including approving themselves', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PATIENT_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off, even for the principal', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('is 400 for an invalid body', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: {},
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('is 409 when the target clinician does not exist', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'nobody' },
      }),
    );
    expect(response.statusCode).toBe(409);
  });

  it('is 404 for a patient that does not exist', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'nope' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('still returns 200 when the notification fails to send — best-effort only', async () => {
    const { handler, sendEmail } = await build();
    (sendEmail as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('SES down'));

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /patients/{id}/decline', () => {
  it('declines and returns 200', async () => {
    const { handler, patientStore } = await build();

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/decline', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect((await patientStore.get('pat-1'))?.account_status).toBe('declined');
  });

  it('sends the patientDeclined notification', async () => {
    const { handler, sendEmail } = await build();
    await invoke(
      handler,
      eventFor('POST /patients/{id}/decline', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('is 403 for a sub-clinician caller', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/decline', {
        principal: SUB_CLINICIAN_CONTEXT,
        pathParameters: { id: 'pat-1' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /patients/{id}/reassign', () => {
  async function buildApproved() {
    const built = await build();
    await built.clinicians.create('cli-2', { displayName: 'Second Clinician', role: 'sub' }, {
      subjectId: 'principal-sub',
      role: 'principal-clinician',
      requestId: 'r',
      sourceIpHash: 'h',
    });
    await invoke(
      built.handler,
      eventFor('POST /patients/{id}/approve', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    return built;
  }

  it('reassigns and returns 200 with the new assignment', async () => {
    const { handler, patientStore } = await buildApproved();

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reassign', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-2' },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect((await patientStore.get('pat-1'))?.assigned_clinician_id).toBe('cli-2');
  });

  it('notifies the patient and both clinicians', async () => {
    const { handler, sendEmail } = await buildApproved();
    (sendEmail as ReturnType<typeof vi.fn>).mockClear();

    await invoke(
      handler,
      eventFor('POST /patients/{id}/reassign', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-2' },
      }),
    );

    // Patient, new clinician, previous clinician — three sends.
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it('is 403 for a sub-clinician caller', async () => {
    const { handler } = await buildApproved();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reassign', {
        principal: SUB_CLINICIAN_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-2' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 409 for a patient that was never approved', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reassign', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-1' },
      }),
    );
    expect(response.statusCode).toBe(409);
  });

  it('is 400 for a body with no assignedClinicianId — there is no request shape that unassigns', async () => {
    const { handler } = await buildApproved();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reassign', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: {},
      }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('still returns 200 when a clinician notification cannot be resolved — best-effort only', async () => {
    const { handler, getClinicianEmail } = await buildApproved();
    (getClinicianEmail.getEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reassign', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
        body: { assignedClinicianId: 'cli-2' },
      }),
    );
    expect(response.statusCode).toBe(200);
  });
});
