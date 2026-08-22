import { describe, expect, it } from 'vitest';

import { InMemoryAuditLog, actorContext } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { InMemoryStore } from './store.js';
import { VersionedRepository, type VersionedRecord } from './versioned-repository.js';

// TASK 2.1.3: repository writes take an `ActorContext` (audit.ts) rather
// than a bare actor string — who, with what role, on which request, from
// where. One fixture stands in for all four here.
const ACTOR = actorContext(
  { subjectId: 'clinician-1', role: 'sub-clinician' },
  { requestId: 'req-version-1', sourceIp: '198.51.100.7' },
);

interface CarePlan extends VersionedRecord {
  summary: string;
}

class SteppingClock implements Clock {
  private ticks = 0;

  now(): Date {
    this.ticks += 1;
    return new Date(2026, 0, 1, 0, 0, this.ticks);
  }
}

function buildRepository() {
  const store = new InMemoryStore<CarePlan>();
  const audit = new InMemoryAuditLog();
  const clock = new SteppingClock();
  const repository = new VersionedRepository<CarePlan>(store, audit, clock, 'CarePlan');
  return { repository, audit, store };
}

describe('VersionedRepository.createVersion', () => {
  it('version N+1 never mutates version N', async () => {
    const { repository } = buildRepository();
    const v1 = await repository.createVersion('pat-1', 1, ACTOR, {
      summary: 'Initial plan',
    });
    const v2 = await repository.createVersion('pat-1', 2, ACTOR, {
      summary: 'Revised plan',
    });

    const readV1 = await repository.getVersion('pat-1', 1);
    expect(readV1).toEqual(v1);
    expect(readV1?.summary).toBe('Initial plan');

    const readV2 = await repository.getVersion('pat-1', 2);
    expect(readV2).toEqual(v2);
    expect(readV2?.summary).toBe('Revised plan');
  });

  it('throws rather than in-place-overwriting an existing version', async () => {
    const { repository } = buildRepository();
    await repository.createVersion('pat-1', 1, ACTOR, { summary: 'Initial plan' });

    await expect(
      repository.createVersion('pat-1', 1, ACTOR, { summary: 'Sneaky overwrite' }),
    ).rejects.toThrow(AppError);

    const stillOriginal = await repository.getVersion('pat-1', 1);
    expect(stillOriginal?.summary).toBe('Initial plan');
  });

  it('writes an audit entry for every version created', async () => {
    const { repository, audit } = buildRepository();
    await repository.createVersion('pat-1', 1, ACTOR, { summary: 'Initial plan' });
    await repository.createVersion('pat-1', 2, ACTOR, { summary: 'Revised plan' });

    expect(audit.list()).toEqual([
      expect.objectContaining({ action: 'create', entityId: 'pat-1#v1' }),
      expect.objectContaining({ action: 'create', entityId: 'pat-1#v2' }),
    ]);
  });

  it('reading a version that was never written returns undefined', async () => {
    const { repository } = buildRepository();
    await expect(repository.getVersion('pat-1', 1)).resolves.toBeUndefined();
  });
});
