import type { BaseRecord } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { Repository } from './repository.js';
import { InMemoryStore } from './store.js';

interface Patient extends BaseRecord {
  name: string;
}

class SteppingClock implements Clock {
  private ticks = 0;

  now(): Date {
    this.ticks += 1;
    return new Date(2026, 0, 1, 0, 0, this.ticks);
  }
}

function buildRepository() {
  const store = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  const clock = new SteppingClock();
  const repository = new Repository<Patient>(store, audit, clock, 'Patient');
  return { repository, audit, store };
}

describe('Repository.create', () => {
  it('stamps created_at, updated_at and status on every write', async () => {
    const { repository } = buildRepository();
    const record = await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    expect(record.created_at).toBe(record.updated_at);
    expect(record.status).toBe('active');
    expect(record.name).toBe('Ada');
  });

  it('throws when a record with the same id already exists', async () => {
    const { repository } = buildRepository();
    await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    await expect(repository.create('pat-1', 'clinician-1', { name: 'Ada 2' })).rejects.toThrow(
      AppError,
    );
  });

  it('writes an audit entry for the create', async () => {
    const { repository, audit } = buildRepository();
    await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    expect(audit.list()).toEqual([
      expect.objectContaining({
        actor: 'clinician-1',
        action: 'create',
        entityType: 'Patient',
        entityId: 'pat-1',
      }),
    ]);
  });
});

describe('Repository.update', () => {
  it('preserves created_at, advances updated_at, and never lets status be smuggled in via the patch', async () => {
    const { repository } = buildRepository();
    const created = await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    const updated = await repository.update('pat-1', 'clinician-1', {
      name: 'Ada Lovelace',
    });
    expect(updated.created_at).toBe(created.created_at);
    expect(updated.updated_at).not.toBe(created.updated_at);
    expect(updated.status).toBe('active');
    expect(updated.name).toBe('Ada Lovelace');
  });

  it('writes an audit entry for the update', async () => {
    const { repository, audit } = buildRepository();
    await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    await repository.update('pat-1', 'clinician-1', { name: 'Ada Lovelace' });
    expect(audit.list().map((e) => e.action)).toEqual(['create', 'update']);
  });

  it('throws when the record does not exist', async () => {
    const { repository } = buildRepository();
    await expect(repository.update('missing', 'clinician-1', { name: 'x' })).rejects.toThrow(
      AppError,
    );
  });

  it('throws rather than in-place-overwriting a soft-deleted record', async () => {
    const { repository } = buildRepository();
    await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    await repository.softDelete('pat-1', 'clinician-1');
    await expect(repository.update('pat-1', 'clinician-1', { name: 'Ada 2' })).rejects.toThrow(
      AppError,
    );
  });
});

describe('Repository.softDelete', () => {
  it('sets a status flag rather than removing the record — it stays readable by id', async () => {
    const { repository } = buildRepository();
    await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    const deleted = await repository.softDelete('pat-1', 'clinician-1');
    expect(deleted.status).toBe('deleted');

    const stillReadable = await repository.findById('pat-1');
    expect(stillReadable).toBeDefined();
    expect(stillReadable?.status).toBe('deleted');
    expect(stillReadable?.name).toBe('Ada');
  });

  it('writes an audit entry for the soft-delete', async () => {
    const { repository, audit } = buildRepository();
    await repository.create('pat-1', 'clinician-1', { name: 'Ada' });
    await repository.softDelete('pat-1', 'clinician-1');
    expect(audit.list().map((e) => e.action)).toEqual(['create', 'soft-delete']);
  });

  it('has no method on Repository that removes a row from the store', () => {
    const repository = new Repository<Patient>(
      new InMemoryStore<Patient>(),
      new InMemoryAuditLog(),
      new SteppingClock(),
      'Patient',
    );
    const methodNames = Object.getOwnPropertyNames(Repository.prototype);
    expect(methodNames).not.toContain('delete');
    expect(methodNames).not.toContain('remove');
    expect(repository).toBeInstanceOf(Repository);
  });
});
