import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import { CaseloadRepository, type CaseloadStore } from './caseload-repository.js';
import { createCaseloadHandler } from './caseload.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

function eventFor(options: {
  readonly principal?: Record<string, unknown>;
  readonly queryStringParameters?: Record<string, string>;
}): LambdaAuthorizerEvent {
  return {
    version: '2.0',
    routeKey: 'GET /caseload',
    rawPath: '/caseload',
    rawQueryString: '',
    headers: {},
    queryStringParameters: options.queryStringParameters,
    isBase64Encoded: false,
    requestContext: {
      accountId: '',
      apiId: '',
      domainName: '',
      domainPrefix: '',
      http: { method: 'GET', path: '/caseload', protocol: 'HTTP/1.1', sourceIp: '203.0.113.9', userAgent: '' },
      requestId: 'req-1',
      routeKey: 'GET /caseload',
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
  accountStatus: 'approved',
  patientId: 'pat-1',
};

class FakeCaseloadStore implements CaseloadStore {
  queryPageCalls: Array<{ cursor: string | undefined; limit: number }> = [];

  async queryPage(cursor: string | undefined, limit: number) {
    this.queryPageCalls.push({ cursor, limit });
    return { patientIds: [], nextCursor: undefined };
  }

  async getPatient() {
    return undefined;
  }
}

function build(overrides: { flagEnabled?: boolean } = {}) {
  const flagSource = new InMemoryFlagSource();
  flagSource.set('caseload.view.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const clinicians = new ClinicianRepository(new InMemoryClinicianStore(), new InMemoryAuditLog(), clock);
  const store = new FakeCaseloadStore();
  const repository = new CaseloadRepository(store, clinicians);

  const handler = createCaseloadHandler({ repository, flags, clock });

  return { handler, store };
}

async function invoke(handler: ReturnType<typeof build>['handler'], event: LambdaAuthorizerEvent) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

describe('GET /caseload', () => {
  it('returns 200 with items and nextCursor for the principal', async () => {
    const { handler } = build();
    const response = await invoke(handler, eventFor({ principal: PRINCIPAL_CONTEXT }));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: unknown[]; nextCursor?: string };
    expect(body.items).toEqual([]);
  });

  it('is 403 for a sub-clinician caller', async () => {
    const { handler } = build();
    const response = await invoke(handler, eventFor({ principal: SUB_CLINICIAN_CONTEXT }));
    expect(response.statusCode).toBe(403);
  });

  it('is 403 for a patient caller', async () => {
    const { handler } = build();
    const response = await invoke(handler, eventFor({ principal: PATIENT_CONTEXT }));
    expect(response.statusCode).toBe(403);
  });

  it('is 403 for a sub-clinician regardless of any query parameter passed — there is no clinician-scoping parameter to exploit', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor({ principal: SUB_CLINICIAN_CONTEXT, queryStringParameters: { cursor: 'x', limit: '5' } }),
    );
    expect(response.statusCode).toBe(403);
  });

  it('is 401 with no verified principal', async () => {
    const { handler } = build();
    const response = await invoke(handler, eventFor({}));
    expect(response.statusCode).toBe(401);
  });

  it('is 404 when the flag is off, even for the principal', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(handler, eventFor({ principal: PRINCIPAL_CONTEXT }));
    expect(response.statusCode).toBe(404);
  });

  it('passes the cursor and limit query parameters through to the repository', async () => {
    const { handler, store } = build();
    await invoke(handler, eventFor({ principal: PRINCIPAL_CONTEXT, queryStringParameters: { cursor: 'abc', limit: '10' } }));

    expect(store.queryPageCalls).toEqual([{ cursor: 'abc', limit: 10 }]);
  });

  it('defaults the page size, and caps an oversized one, rather than trusting the caller', async () => {
    const { handler, store } = build();
    await invoke(handler, eventFor({ principal: PRINCIPAL_CONTEXT }));
    await invoke(handler, eventFor({ principal: PRINCIPAL_CONTEXT, queryStringParameters: { limit: '9999' } }));
    await invoke(handler, eventFor({ principal: PRINCIPAL_CONTEXT, queryStringParameters: { limit: 'not-a-number' } }));

    expect(store.queryPageCalls.map((c) => c.limit)).toEqual([25, 100, 25]);
  });
});
