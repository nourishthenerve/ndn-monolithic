import type { Appointment } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import { unprojected } from './projection.js';
import {
  createTurnCredentialsHandler,
  TURN_CREDENTIAL_TTL_SECONDS,
  type Fetcher,
  type TurnAppointmentReader,
  type TurnCallParticipant,
  type TurnCallParticipantsReader,
  type TurnCredentialsDeps,
} from './turn-credentials.js';

const SCHEDULED_AT = '2026-09-01T10:00:00.000Z';
const APPOINTMENT_ID = `pat-1#${SCHEDULED_AT}`;
const ROUTE = 'POST /calls/{appointmentId}/turn-credentials';
// Relative to the fixed test clock below, never real wall-clock `Date.now()`.
const NOW_SECONDS = Math.floor(new Date(SCHEDULED_AT).getTime() / 1000);

function clockAt(iso: string): Clock {
  return { now: () => new Date(iso) };
}

function appointment(overrides: Partial<Appointment> = {}): Appointment {
  return {
    patientId: 'pat-1',
    clinicianId: 'cli-1',
    scheduledAt: SCHEDULED_AT,
    durationMinutes: 30,
    appointment_status: 'scheduled',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    status: 'active',
    ...overrides,
  };
}

class InMemoryAppointmentReader implements TurnAppointmentReader {
  constructor(private readonly items: Appointment[]) {}
  async get(patientId: string, scheduledAt: string) {
    const item = this.items.find((it) => it.patientId === patientId && it.scheduledAt === scheduledAt);
    return item ? unprojected(item) : undefined;
  }
}

function connectionsReturning(participants: TurnCallParticipant[]): TurnCallParticipantsReader {
  return { findCallParticipants: async () => participants };
}

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

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

function fakeEvent(overrides: {
  routeKey?: string;
  pathParameters?: Record<string, string>;
  principal?: Record<string, unknown>;
}): LambdaAuthorizerEvent {
  return {
    routeKey: overrides.routeKey ?? ROUTE,
    pathParameters: overrides.pathParameters ?? { appointmentId: APPOINTMENT_ID },
    requestContext: {
      requestId: 'req-1',
      http: { sourceIp: '198.51.100.7' },
      authorizer: { lambda: 'principal' in overrides ? overrides.principal : ASSIGNED_SUB_CONTEXT },
    },
  } as unknown as LambdaAuthorizerEvent;
}

function enabledFlags() {
  const source = new InMemoryFlagSource();
  source.set('video.turn.enabled', true);
  return new CachedFlagReader({ source, clock: clockAt(SCHEDULED_AT), ttlMs: 0 });
}

const LIVE_JOIN: TurnCallParticipant = { principalId: 'sub-1', ttl: NOW_SECONDS + 3600 };

function jsonFetcher(status: number, body: unknown): Fetcher {
  return async () => ({ ok: status >= 200 && status < 300, json: async () => body });
}

function throwingFetcher(): Fetcher {
  return async () => {
    throw new Error('network error');
  };
}

function build(options: {
  appointments?: Appointment[];
  participants?: TurnCallParticipant[];
  flagsEnabled?: boolean;
  fetcher?: Fetcher;
} = {}) {
  const appointments = new InMemoryAppointmentReader(options.appointments ?? [appointment()]);
  const connections = connectionsReturning(options.participants ?? [LIVE_JOIN]);
  const flags = options.flagsEnabled === false ? { isEnabled: async () => false } : enabledFlags();
  const logs: Array<{ route: string; statusCode: number }> = [];

  const deps: TurnCredentialsDeps = {
    appointments,
    connections,
    flags,
    keyId: 'test-key-id',
    getApiToken: async () => 'test-api-token',
    clock: clockAt(SCHEDULED_AT),
    fetcher:
      options.fetcher ??
      jsonFetcher(200, {
        iceServers: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'super-secret-turn-credential' },
      }),
    logger: { logRequest: (entry) => logs.push({ route: entry.route, statusCode: entry.statusCode }) },
  };

  return { handler: createTurnCredentialsHandler(deps), logs };
}

async function invoke(
  handler: ReturnType<typeof createTurnCredentialsHandler>,
  event: LambdaAuthorizerEvent,
) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

describe('createTurnCredentialsHandler', () => {
  it('404s when the flag is off, before any principal or appointment lookup', async () => {
    const { handler } = build({ flagsEnabled: false });
    const response = await invoke(handler, fakeEvent({}));
    expect(response).toMatchObject({ statusCode: 404 });
  });

  it('404s a route it does not own', async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({ routeKey: 'GET /something-else' }));
    expect(response).toMatchObject({ statusCode: 404 });
  });

  it('401s with no verified principal', async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({ principal: undefined }));
    expect(response).toMatchObject({ statusCode: 401 });
  });

  it('400s a missing appointmentId path parameter', async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({ pathParameters: {} }));
    expect(response).toMatchObject({ statusCode: 400 });
  });

  it('refuses a malformed appointmentId the same way as an unowned one — not-your-appointment, never a distinct signal', async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({ pathParameters: { appointmentId: 'not-a-real-id' } }));
    expect(response).toMatchObject({ statusCode: 403 });
    expect(JSON.parse(response.body)).toEqual({ error: 'FORBIDDEN', reason: 'not-your-appointment' });
  });

  it('refuses an appointment id that does not exist — cannot leak whether it does', async () => {
    const { handler } = build({ appointments: [] });
    const response = await invoke(handler, fakeEvent({}));
    expect(JSON.parse(response.body)).toEqual({ error: 'FORBIDDEN', reason: 'not-your-appointment' });
  });

  it("refuses an unassigned sub-clinician — can()'s own join-call decision, not re-implemented", async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({ principal: UNASSIGNED_SUB_CONTEXT }));
    expect(JSON.parse(response.body)).toEqual({ error: 'FORBIDDEN', reason: 'not-your-appointment' });
  });

  it('refuses a principal who never joined this call — allowed by can(), but no CALL# row', async () => {
    const { handler } = build({ participants: [] });
    const response = await invoke(handler, fakeEvent({}));
    expect(JSON.parse(response.body)).toEqual({ error: 'FORBIDDEN', reason: 'not-joined' });
  });

  it('refuses a principal whose CALL# row has already expired, even though they joined earlier', async () => {
    const { handler } = build({
      participants: [{ principalId: 'sub-1', ttl: NOW_SECONDS - 60 }],
    });
    const response = await invoke(handler, fakeEvent({}));
    expect(JSON.parse(response.body)).toEqual({ error: 'FORBIDDEN', reason: 'not-joined' });
  });

  it("refuses against another principal's live CALL# row — matched by principalId, not merely by any row existing", async () => {
    const { handler } = build({ participants: [{ principalId: 'someone-else', ttl: NOW_SECONDS + 3600 }] });
    const response = await invoke(handler, fakeEvent({}));
    expect(JSON.parse(response.body)).toEqual({ error: 'FORBIDDEN', reason: 'not-joined' });
  });

  it('the owning patient can also obtain credentials for their own live call', async () => {
    const { handler } = build({
      participants: [{ principalId: 'pat-1', ttl: NOW_SECONDS + 3600 }],
    });
    const response = await invoke(handler, fakeEvent({ principal: OWNING_PATIENT_CONTEXT }));
    expect(response.statusCode).toBe(200);
  });

  it('issues a real credential for the assigned, already-joined sub-clinician', async () => {
    const { handler } = build();
    const response = await invoke(handler, fakeEvent({}));
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      iceServer: { urls: ['turn:turn.cloudflare.com:3478'], username: 'u', credential: 'super-secret-turn-credential' },
    });
  });

  it('normalises a single-string urls field into an array', async () => {
    const { handler } = build({
      fetcher: jsonFetcher(200, {
        iceServers: { urls: 'turn:turn.cloudflare.com:3478', username: 'u', credential: 'super-secret-turn-credential' },
      }),
    });
    const response = await invoke(handler, fakeEvent({}));
    expect(JSON.parse(response.body).iceServer.urls).toEqual(['turn:turn.cloudflare.com:3478']);
  });

  it("requests the plan's own named TTL from Cloudflare, not a magic number", async () => {
    let requestedBody: unknown;
    const fetcher: Fetcher = async (_url, init) => {
      requestedBody = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ iceServers: { urls: ['x'], username: 'u', credential: 'super-secret-turn-credential' } }) };
    };
    const { handler } = build({ fetcher });
    await invoke(handler, fakeEvent({}));
    expect(requestedBody).toEqual({ ttl: TURN_CREDENTIAL_TTL_SECONDS });
  });

  it('502s on a non-2xx response from Cloudflare', async () => {
    const { handler } = build({ fetcher: jsonFetcher(500, {}) });
    const response = await invoke(handler, fakeEvent({}));
    expect(response.statusCode).toBe(502);
  });

  it('502s on a response that does not match the expected shape', async () => {
    const { handler } = build({ fetcher: jsonFetcher(200, { unexpected: true }) });
    const response = await invoke(handler, fakeEvent({}));
    expect(response.statusCode).toBe(502);
  });

  it('502s rather than throwing when the provider call itself fails', async () => {
    const { handler } = build({ fetcher: throwingFetcher() });
    const response = await invoke(handler, fakeEvent({}));
    expect(response.statusCode).toBe(502);
  });

  it('never logs the credential value — only route/statusCode reach the logger', async () => {
    const { handler, logs } = build();
    await invoke(handler, fakeEvent({}));
    for (const entry of logs) {
      expect(JSON.stringify(entry)).not.toContain('super-secret-turn-credential');
      expect(Object.keys(entry)).toEqual(['route', 'statusCode']);
    }
    expect(logs).toEqual([{ route: ROUTE, statusCode: 200 }]);
  });
});
