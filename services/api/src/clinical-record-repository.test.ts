import type { ClinicalRecord } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import { ClinicalRecordRepository } from './clinical-record-repository.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const ACTOR = actorContext(
  { subjectId: 'sub-1', role: 'sub-clinician' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);

function build(kind: 'diagnosis' | 'care-plan' = 'diagnosis') {
  const store = new InMemoryStore<ClinicalRecord>();
  const audit = new InMemoryAuditLog();
  const repository = new ClinicalRecordRepository(store, audit, clock, kind);
  return { repository, store, audit };
}

describe('ClinicalRecordRepository.createVersion', () => {
  it('version 2 never mutates version 1, and both remain independently readable', async () => {
    const { repository } = build();
    const v1 = await repository.createVersion('pat-1', 1, ACTOR, {
      visible: { summary: 'Initial' },
    });
    const v2 = await repository.createVersion('pat-1', 2, ACTOR, {
      visible: { summary: 'Revised' },
    });

    expect(await repository.getVersion('pat-1', 1)).toEqual(v1);
    expect(await repository.getVersion('pat-1', 2)).toEqual(v2);
    expect((await repository.getVersion('pat-1', 1))?.visible.summary).toBe('Initial');
  });

  it('throws VERSION_ALREADY_EXISTS rather than overwriting an existing version', async () => {
    const { repository } = build();
    await repository.createVersion('pat-1', 1, ACTOR, { visible: { summary: 'Initial' } });

    await expect(
      repository.createVersion('pat-1', 1, ACTOR, { visible: { summary: 'Sneaky overwrite' } }),
    ).rejects.toThrow(AppError);

    expect((await repository.getVersion('pat-1', 1))?.visible.summary).toBe('Initial');
  });

  it('stores no `private` key at all when the caller supplies none — not an empty object', async () => {
    const { repository } = build();
    const created = await repository.createVersion('pat-1', 1, ACTOR, {
      visible: { summary: 'Initial' },
    });
    expect(Object.prototype.hasOwnProperty.call(created, 'private')).toBe(false);
  });

  it('stores the private half exactly as given when the caller supplies one', async () => {
    const { repository } = build();
    const created = await repository.createVersion('pat-1', 1, ACTOR, {
      visible: { summary: 'Initial' },
      private: { notes: 'clinician-only note' },
    });
    expect(created.private).toEqual({ notes: 'clinician-only note' });
  });

  it('records the patientId on the version', async () => {
    const { repository } = build();
    const created = await repository.createVersion('pat-1', 1, ACTOR, {
      visible: { summary: 'Initial' },
    });
    expect(created.patientId).toBe('pat-1');
  });

  it('writes an audit entry named by the entity kind, distinguishing diagnosis from care plan', async () => {
    const { repository: diagnosisRepo, audit: diagnosisAudit } = build('diagnosis');
    await diagnosisRepo.createVersion('pat-1', 1, ACTOR, { visible: { summary: 'Initial' } });
    expect(diagnosisAudit.list()).toEqual([
      expect.objectContaining({ action: 'create', entityType: 'diagnosis', entityId: 'pat-1#v1' }),
    ]);

    const { repository: carePlanRepo, audit: carePlanAudit } = build('care-plan');
    await carePlanRepo.createVersion('pat-1', 1, ACTOR, { visible: { summary: 'Initial' } });
    expect(carePlanAudit.list()).toEqual([
      expect.objectContaining({ action: 'create', entityType: 'care-plan', entityId: 'pat-1#v1' }),
    ]);
  });

  it('reading a version that was never written returns undefined', async () => {
    const { repository } = build();
    await expect(repository.getVersion('pat-1', 1)).resolves.toBeUndefined();
  });
});

describe('ClinicalRecordRepository.listVersions', () => {
  it('returns every version for the patient, oldest first', async () => {
    const { repository } = build();
    await repository.createVersion('pat-1', 1, ACTOR, { visible: { summary: 'Initial' } });
    await repository.createVersion('pat-1', 2, ACTOR, { visible: { summary: 'Revised' } });

    const versions = await repository.listVersions('pat-1');
    expect(versions.map((v) => v.visible.summary)).toEqual(['Initial', 'Revised']);
  });
});
