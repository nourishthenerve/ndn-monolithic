// TASK 2.1.3's two named negatives — "GET /audit as a patient and as a
// sub-clinician → 403, both asserted" — plus the rest of the boundary:
// flag off, no identity, the matrix's one allowed column, and the date
// parameter.
//
// Every denial here is `can()`'s decision, not this handler's. The tests
// are written against principals rather than tokens for that reason: when
// TASK 2.2.2 replaces the principal source, none of them changes.
import type { Principal } from '@ndn/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { createAuditReadHandler, type AuditReadDeps } from './audit-read.js';
import type { AuditEvent, AuditReader } from './audit.js';
import { actorContext, auditEventFor } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, InMemoryFlagSource } from './flags.js';
import { containsPrivateField } from './projection.js';

const fixedClock: Clock = { now: () => new Date('2026-08-21T12:00:00.000Z') };

const PRINCIPAL_CLINICIAN: Principal = {
  subjectId: 'sub-principal',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'clin-principal',
};

const SUB_CLINICIAN: Principal = {
  subjectId: 'sub-clinician',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'clin-1',
};

const PATIENT: Principal = {
  subjectId: 'sub-patient',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'pat-1',
};

const EVENTS: readonly AuditEvent[] = [
  auditEventFor(
    actorContext(
      { subjectId: 'clin-1', role: 'sub-clinician' },
      { requestId: 'req-a', sourceIp: '198.51.100.7' },
    ),
    {
      at: '2026-08-21T09:00:00.000Z',
      action: 'create',
      entityType: 'CarePlan',
      entityId: 'plan-1',
    },
  ),
  auditEventFor(
    actorContext(
      { subjectId: 'clin-1', role: 'sub-clinician' },
      { requestId: 'req-b', sourceIp: '198.51.100.7' },
    ),
    {
      at: '2026-08-21T10:00:00.000Z',
      action: 'update',
      entityType: 'CarePlan',
      entityId: 'plan-1',
    },
  ),
];

function buildDeps(
  overrides: Partial<AuditReadDeps> & { flagOn?: boolean; principal?: Principal } = {},
): AuditReadDeps & { reader: { listByDate: ReturnType<typeof vi.fn> } } {
  const source = new InMemoryFlagSource();
  source.set('audit.readApi.enabled', overrides.flagOn ?? true);
  const reader = { listByDate: vi.fn(async () => EVENTS) };
  return {
    reader: reader as AuditReader & { listByDate: ReturnType<typeof vi.fn> },
    flags: new CachedFlagReader({ source, clock: fixedClock, ttlMs: 30_000 }),
    resolvePrincipal: async () =>
      'principal' in overrides ? overrides.principal : PRINCIPAL_CLINICIAN,
    clock: fixedClock,
    logger: { logRequest: vi.fn() },
    ...overrides,
  } as AuditReadDeps & { reader: { listByDate: ReturnType<typeof vi.fn> } };
}

function fakeEvent(date?: string) {
  return {
    routeKey: 'GET /audit',
    queryStringParameters: date === undefined ? undefined : { date },
    headers: {},
    requestContext: { requestId: 'req-1', http: { sourceIp: '203.0.113.4' } },
  } as never;
}

async function call(deps: AuditReadDeps, date?: string) {
  const result = await createAuditReadHandler(deps)(
    fakeEvent(date),
    {} as never,
    undefined as never,
  );
  return result as { statusCode: number; body: string };
}

describe('createAuditReadHandler — flag gating', () => {
  it('returns 404 while audit.readApi.enabled is off, without resolving a principal', async () => {
    const resolvePrincipal = vi.fn(async () => PRINCIPAL_CLINICIAN);
    const deps = buildDeps({ flagOn: false, resolvePrincipal });

    const result = await call(deps, '2026-08-21');

    expect(result.statusCode).toBe(404);
    expect(resolvePrincipal).not.toHaveBeenCalled();
    expect(deps.reader.listByDate).not.toHaveBeenCalled();
  });
});

describe('createAuditReadHandler — authorisation', () => {
  it('answers 401 when the request carries no identity at all', async () => {
    const deps = buildDeps({ principal: undefined });

    const result = await call(deps, '2026-08-21');

    expect(result.statusCode).toBe(401);
    expect(deps.reader.listByDate).not.toHaveBeenCalled();
  });

  it('denies a patient with 403 and reads nothing', async () => {
    const deps = buildDeps({ principal: PATIENT });

    const result = await call(deps, '2026-08-21');

    expect(result.statusCode).toBe(403);
    expect(JSON.parse(result.body)).toEqual({ error: 'FORBIDDEN' });
    expect(deps.reader.listByDate).not.toHaveBeenCalled();
  });

  it('denies a sub-clinician with 403 and reads nothing', async () => {
    const deps = buildDeps({ principal: SUB_CLINICIAN });

    const result = await call(deps, '2026-08-21');

    expect(result.statusCode).toBe(403);
    expect(deps.reader.listByDate).not.toHaveBeenCalled();
  });

  it('denies a deactivated principal clinician — status gates before role does', async () => {
    const deps = buildDeps({
      principal: { ...PRINCIPAL_CLINICIAN, accountStatus: 'deactivated' },
    });

    expect((await call(deps, '2026-08-21')).statusCode).toBe(403);
  });

  it('denies before parsing the date, so a refusal reveals nothing about the query', async () => {
    const deps = buildDeps({ principal: PATIENT });

    // No date at all — a permitted caller would get 400 here; a denied one
    // must not be able to tell the two apart.
    expect((await call(deps)).statusCode).toBe(403);
  });

  it('allows the principal clinician, the matrix’s only R on the audit log', async () => {
    const deps = buildDeps();

    const result = await call(deps, '2026-08-21');

    expect(result.statusCode).toBe(200);
    expect(deps.reader.listByDate).toHaveBeenCalledWith('2026-08-21');
    expect(JSON.parse(result.body).items).toHaveLength(2);
  });
});

describe('createAuditReadHandler — the date parameter', () => {
  it('requires one', async () => {
    const deps = buildDeps();

    const result = await call(deps);

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'DATE_REQUIRED' });
    expect(deps.reader.listByDate).not.toHaveBeenCalled();
  });

  it('rejects anything that is not yyyy-mm-dd', async () => {
    const deps = buildDeps();

    const result = await call(deps, '21-08-2026');

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body)).toEqual({ error: 'INVALID_DATE' });
    expect(deps.reader.listByDate).not.toHaveBeenCalled();
  });
});

describe('createAuditReadHandler — the response', () => {
  it('returns the day’s events in the order the reader gave them', async () => {
    const result = await call(buildDeps(), '2026-08-21');

    expect(JSON.parse(result.body).items.map((item: AuditEvent) => item.at)).toEqual([
      '2026-08-21T09:00:00.000Z',
      '2026-08-21T10:00:00.000Z',
    ]);
  });

  // docs/runbooks/private-field-boundary.md's "negative test per endpoint,
  // forever" (NFR-06). An audit row has no private half today; the test
  // exists so that the day one does, this endpoint fails rather than leaks.
  it('carries no private{} attribute, even when a row somehow has one', async () => {
    const deps = buildDeps({
      reader: {
        listByDate: vi.fn(async () => [
          { ...EVENTS[0], private: { note: 'a clinician-only note' } } as unknown as AuditEvent,
        ]),
      } as unknown as AuditReader,
    });

    const result = await call(deps, '2026-08-21');

    expect(containsPrivateField(JSON.parse(result.body))).toBe(false);
    expect(result.body).not.toContain('a clinician-only note');
  });

  it('logs every request, including the denials', async () => {
    const logRequest = vi.fn();
    const deps = buildDeps({ principal: PATIENT, logger: { logRequest } });

    await call(deps, '2026-08-21');

    expect(logRequest).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'req-1', route: '/audit', statusCode: 403 }),
    );
  });
});
