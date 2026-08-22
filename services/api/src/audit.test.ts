import type { Principal } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import {
  actorContext,
  actorFromPrincipal,
  auditEventFor,
  hashSourceIp,
  InMemoryAuditLog,
  requestOriginOf,
  type ActorContext,
} from './audit.js';

const ORIGIN = { requestId: 'req-1', sourceIp: '198.51.100.7' };

const ACTOR: ActorContext = actorContext(
  { subjectId: 'clinician-1', role: 'sub-clinician' },
  ORIGIN,
);

describe('InMemoryAuditLog', () => {
  it('is append-only: list() reflects every write, in order, and exposes no removal method', async () => {
    const log = new InMemoryAuditLog();
    await log.write(
      auditEventFor(ACTOR, {
        at: '2026-01-01T00:00:00.000Z',
        action: 'create',
        entityType: 'Patient',
        entityId: 'pat-1',
      }),
    );
    await log.write(
      auditEventFor(ACTOR, {
        at: '2026-01-01T00:00:01.000Z',
        action: 'update',
        entityType: 'Patient',
        entityId: 'pat-1',
      }),
    );

    expect(log.list().map((e) => e.action)).toEqual(['create', 'update']);
    const methodNames = Object.getOwnPropertyNames(InMemoryAuditLog.prototype);
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('remove');
    expect(methodNames).not.toContain('clear');
  });

  it('list() returns a copy — mutating it does not affect the underlying log', async () => {
    const log = new InMemoryAuditLog();
    await log.write(
      auditEventFor(ACTOR, {
        at: '2026-01-01T00:00:00.000Z',
        action: 'create',
        entityType: 'Patient',
        entityId: 'pat-1',
      }),
    );

    const snapshot = log.list() as unknown[];
    snapshot.pop();
    expect(log.list()).toHaveLength(1);
  });
});

// TASK 2.1.3 step 2: the "where" the data model has always asked for.
describe('hashSourceIp', () => {
  it('never returns the address itself, and is stable for the same address', () => {
    const hashed = hashSourceIp('198.51.100.7');

    expect(hashed).not.toContain('198.51.100.7');
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSourceIp('198.51.100.7')).toBe(hashed);
  });

  it('separates two different addresses', () => {
    expect(hashSourceIp('198.51.100.7')).not.toBe(hashSourceIp('198.51.100.8'));
  });
});

describe('actorContext', () => {
  it('carries the request id through and the source address only as a hash', () => {
    expect(ACTOR).toEqual({
      subjectId: 'clinician-1',
      role: 'sub-clinician',
      requestId: 'req-1',
      sourceIpHash: hashSourceIp('198.51.100.7'),
    });
    expect(JSON.stringify(ACTOR)).not.toContain('198.51.100.7');
  });

  it('records the three non-Role actors Phase 1 still writes rows as', () => {
    const roles = (['admin-token', 'public', 'system'] as const).map(
      (role) => actorContext({ subjectId: 'x', role }, ORIGIN).role,
    );
    expect(roles).toEqual(['admin-token', 'public', 'system']);
  });
});

describe('actorFromPrincipal', () => {
  it('takes who from the Principal and where from the request — a principal is already the "who"', () => {
    const principal: Principal = {
      subjectId: 'sub-abc',
      role: 'principal-clinician',
      accountStatus: 'active',
      clinicianId: 'clin-1',
    };

    expect(actorFromPrincipal(principal, ORIGIN)).toEqual({
      subjectId: 'sub-abc',
      role: 'principal-clinician',
      requestId: 'req-1',
      sourceIpHash: hashSourceIp('198.51.100.7'),
    });
  });

  it('carries nothing else off the principal — an audit row is identifiers only', () => {
    const principal: Principal = {
      subjectId: 'sub-abc',
      role: 'patient',
      accountStatus: 'approved',
      patientId: 'pat-9',
    };

    expect(Object.keys(actorFromPrincipal(principal, ORIGIN)).sort()).toEqual([
      'requestId',
      'role',
      'sourceIpHash',
      'subjectId',
    ]);
  });
});

describe('requestOriginOf', () => {
  it('reads exactly the request id and source address off an API Gateway event', () => {
    expect(
      requestOriginOf({
        requestContext: { requestId: 'req-42', http: { sourceIp: '203.0.113.4' } },
      }),
    ).toEqual({ requestId: 'req-42', sourceIp: '203.0.113.4' });
  });
});

describe('auditEventFor', () => {
  it('is the one mapping from actor + facts to a row: who, what, when, where', () => {
    expect(
      auditEventFor(ACTOR, {
        at: '2026-08-21T10:00:00.000Z',
        action: 'update',
        entityType: 'CarePlan',
        entityId: 'plan-1',
      }),
    ).toEqual({
      at: '2026-08-21T10:00:00.000Z',
      actor: 'clinician-1',
      actorRole: 'sub-clinician',
      action: 'update',
      entityType: 'CarePlan',
      entityId: 'plan-1',
      requestId: 'req-1',
      sourceIpHash: hashSourceIp('198.51.100.7'),
    });
  });
});
