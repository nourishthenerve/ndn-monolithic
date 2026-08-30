import type { Message, Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import type { MessagePage, MessageStore } from './message-repository.js';
import { MessageRepository } from './message-repository.js';
import { createMessageHandler } from './message.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryRateLimiter, type RateLimiter } from './rate-limiter.js';
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

/** In-memory `MessageStore` — this file exercises `message.ts`'s own routing/authz/rate-limit logic; the real Query/cursor shape is `dynamo-store.test.ts`'s job. */
class InMemoryMessageStore implements MessageStore {
  private readonly items: Message[] = [];

  async create(message: Message): Promise<void> {
    this.items.push(message);
  }

  async listForThread(patientId: string, cursor: string | undefined, limit: number): Promise<MessagePage> {
    const all = this.items
      .filter((item) => item.patientId === patientId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const start = cursor ? Number(cursor) : 0;
    const page = all.slice(start, start + limit);
    const nextCursor = start + limit < all.length ? String(start + limit) : undefined;
    return { items: page, nextCursor };
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

async function build(overrides: { flagEnabled?: boolean; rateLimit?: number } = {}) {
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

  const messages = new MessageRepository(new InMemoryMessageStore(), new InMemoryAuditLog(), clock);

  const flagSource = new InMemoryFlagSource();
  flagSource.set('messaging.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const rateLimiter: RateLimiter = new InMemoryRateLimiter({
    clock,
    limit: overrides.rateLimit ?? 30,
    windowMs: 60 * 60 * 1000,
  });

  const handler = createMessageHandler({
    patients,
    messages,
    flags,
    rateLimiter,
    clock,
  });
  return { handler, patients, messages };
}

async function invoke(handler: ReturnType<typeof createMessageHandler>, event: LambdaAuthorizerEvent) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const SEND_ROUTE = 'POST /patients/{id}/messages';
const LIST_ROUTE = 'GET /patients/{id}/messages';

describe('POST /patients/{id}/messages', () => {
  it('sends a message for the owning patient', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'Hello' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: { senderRole: string; body: string } };
    expect(body.item.senderRole).toBe('patient');
    expect(body.item.body).toBe('Hello');
  });

  it('sends a message for an assigned sub-clinician — the matrix correction this task makes', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'Hi, checking in' },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { item: { senderRole: string } };
    expect(body.item.senderRole).toBe('sub-clinician');
  });

  it("is 403 for the principal — a real finding: this task's own step 2 claims the principal can send, but authz-matrix.ts's Messages row Principal cell stays bare R", async () => {
    const { handler, messages } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'Hello' },
        principal: PRINCIPAL_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(messages.listForThread('pat-1')).resolves.toEqual({ items: [], nextCursor: undefined });
  });

  it('is 403 for an unassigned sub-clinician, before any write', async () => {
    const { handler, messages } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'Hello' },
        principal: UNASSIGNED_SUB_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(403);
    await expect(messages.listForThread('pat-1')).resolves.toEqual({ items: [], nextCursor: undefined });
  });

  it('is 403, never a 200 with a partial body, for a patient sending into another patient\'s thread by a guessed id', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'Hello' },
        principal: { ...OWNING_PATIENT_CONTEXT, subjectId: 'pat-2', patientId: 'pat-2' },
      }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 429, not a silent drop, once the rate limit is exhausted', async () => {
    const { handler } = await build({ rateLimit: 1 });
    await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'first' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'second' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(429);
  });

  it('is 400 for an empty body or an unrecognised field, without consuming a rate-limit slot', async () => {
    const { handler, messages } = await build({ rateLimit: 1 });
    const empty = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: '' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(empty.statusCode).toBe(400);

    const smuggled = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'hi', senderId: 'someone-else' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(smuggled.statusCode).toBe(400);

    // The rate-limit slot from a real successful send is still available —
    // proving the two 400s above never consumed one.
    const real = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'a real message' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(real.statusCode).toBe(201);
    await expect(messages.listForThread('pat-1')).resolves.toMatchObject({
      items: [{ body: 'a real message' }],
    });
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'Hello' },
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
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'Hello' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('GET /patients/{id}/messages', () => {
  async function seedTwo(handler: ReturnType<typeof createMessageHandler>) {
    await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'from patient' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    await invoke(
      handler,
      fakeEvent({
        routeKey: SEND_ROUTE,
        pathParameters: { id: 'pat-1' },
        body: { body: 'from clinician' },
      }),
    );
  }

  it('returns the thread for the owning patient, chronologically', async () => {
    const { handler } = await build();
    await seedTwo(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: LIST_ROUTE,
        pathParameters: { id: 'pat-1' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: { body: string }[] };
    expect(body.items.map((item) => item.body)).toEqual(['from patient', 'from clinician']);
  });

  it('resolves /patients/me/messages to the owning patient', async () => {
    const { handler } = await build();
    await seedTwo(handler);
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: LIST_ROUTE,
        pathParameters: { id: 'me' },
        principal: OWNING_PATIENT_CONTEXT,
      }),
    );
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it('is 200 for an assigned sub-clinician and for the principal — the principal reads any thread, the same cross-caseload oversight every other row grants them', async () => {
    const { handler } = await build();
    await seedTwo(handler);

    const subResponse = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' } }),
    );
    expect(subResponse.statusCode).toBe(200);

    const principalResponse = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: PRINCIPAL_CONTEXT }),
    );
    expect(principalResponse.statusCode).toBe(200);
  });

  it('is 403 for an unassigned sub-clinician', async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: UNASSIGNED_SUB_CONTEXT }),
    );
    expect(response.statusCode).toBe(403);
  });

  it("is 403, never a 200 with a partial body, for a patient reading another patient's thread by a guessed id", async () => {
    const { handler } = await build();
    const response = await invoke(
      handler,
      fakeEvent({
        routeKey: LIST_ROUTE,
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
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: undefined }),
    );
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off', async () => {
    const { handler } = await build({ flagEnabled: false });
    const response = await invoke(
      handler,
      fakeEvent({ routeKey: LIST_ROUTE, pathParameters: { id: 'pat-1' }, principal: OWNING_PATIENT_CONTEXT }),
    );
    expect(response.statusCode).toBe(404);
  });
});
