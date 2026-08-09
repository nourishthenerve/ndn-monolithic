import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';

describe('InMemoryAuditLog', () => {
  it('is append-only: list() reflects every write, in order, and exposes no removal method', async () => {
    const log = new InMemoryAuditLog();
    await log.write({
      at: '2026-01-01T00:00:00.000Z',
      actor: 'clinician-1',
      action: 'create',
      entityType: 'Patient',
      entityId: 'pat-1',
    });
    await log.write({
      at: '2026-01-01T00:00:01.000Z',
      actor: 'clinician-1',
      action: 'update',
      entityType: 'Patient',
      entityId: 'pat-1',
    });

    expect(log.list().map((e) => e.action)).toEqual(['create', 'update']);
    const methodNames = Object.getOwnPropertyNames(InMemoryAuditLog.prototype);
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('remove');
    expect(methodNames).not.toContain('clear');
  });

  it('list() returns a copy — mutating it does not affect the underlying log', async () => {
    const log = new InMemoryAuditLog();
    await log.write({
      at: '2026-01-01T00:00:00.000Z',
      actor: 'clinician-1',
      action: 'create',
      entityType: 'Patient',
      entityId: 'pat-1',
    });

    const snapshot = log.list() as unknown[];
    snapshot.pop();
    expect(log.list()).toHaveLength(1);
  });
});
