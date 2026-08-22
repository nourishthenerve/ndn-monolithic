import type { Assessment } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { AssessmentRepository } from './assessment-repository.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const ACTOR = actorContext(
  { subjectId: 'sub-1', role: 'sub-clinician' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);

function build() {
  const store = new InMemoryStore<Assessment>();
  const audit = new InMemoryAuditLog();
  const repository = new AssessmentRepository(store, audit, clock);
  return { repository, store, audit };
}

describe('AssessmentRepository.createVersion', () => {
  it('version 2 of the same named form never mutates version 1, and both remain independently readable', async () => {
    const { repository } = build();
    const v1 = await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: { painScore: 4 } },
    });
    const v2 = await repository.createVersion('pat-1', 'mobility-initial', 2, ACTOR, {
      visible: { formType: 'mobility', responses: { painScore: 2 } },
    });

    expect(await repository.getVersion('pat-1', 'mobility-initial', 1)).toEqual(v1);
    expect(await repository.getVersion('pat-1', 'mobility-initial', 2)).toEqual(v2);
    expect(
      (await repository.getVersion('pat-1', 'mobility-initial', 1))?.visible.responses,
    ).toEqual({ painScore: 4 });
  });

  it('throws VERSION_ALREADY_EXISTS rather than overwriting an existing version of the same form', async () => {
    const { repository } = build();
    await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: {} },
    });

    await expect(
      repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
        visible: { formType: 'mobility', responses: { sneaky: true } },
      }),
    ).rejects.toThrow(AppError);
  });

  it('keeps two different named forms for the same patient fully independent, even at the same version number', async () => {
    const { repository } = build();
    await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: { painScore: 4 } },
    });
    await repository.createVersion('pat-1', 'balance-initial', 1, ACTOR, {
      visible: { formType: 'balance', responses: { fallsRisk: 'low' } },
    });

    const mobility = await repository.getVersion('pat-1', 'mobility-initial', 1);
    const balance = await repository.getVersion('pat-1', 'balance-initial', 1);
    expect(mobility?.visible.formType).toBe('mobility');
    expect(balance?.visible.formType).toBe('balance');
  });

  it('stores no `private` key at all when the caller supplies none', async () => {
    const { repository } = build();
    const created = await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: {} },
    });
    expect(Object.prototype.hasOwnProperty.call(created, 'private')).toBe(false);
  });

  it('stores the private half exactly as given when the caller supplies one', async () => {
    const { repository } = build();
    const created = await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: {} },
      private: { clinicianImpression: 'query non-organic presentation' },
    });
    expect(created.private).toEqual({ clinicianImpression: 'query non-organic presentation' });
  });

  it('records the patientId and assessmentId on the version', async () => {
    const { repository } = build();
    const created = await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: {} },
    });
    expect(created.patientId).toBe('pat-1');
    expect(created.assessmentId).toBe('mobility-initial');
  });

  it('writes an audit entry keyed by the composite id', async () => {
    const { repository, audit } = build();
    await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: {} },
    });
    expect(audit.list()).toEqual([
      expect.objectContaining({
        action: 'create',
        entityType: 'assessment',
        entityId: 'pat-1#mobility-initial#v1',
      }),
    ]);
  });

  it('reading a version that was never written returns undefined', async () => {
    const { repository } = build();
    await expect(repository.getVersion('pat-1', 'mobility-initial', 1)).resolves.toBeUndefined();
  });
});

describe('AssessmentRepository.listVersions', () => {
  it('returns every version of one named form, oldest first', async () => {
    const { repository } = build();
    await repository.createVersion('pat-1', 'mobility-initial', 1, ACTOR, {
      visible: { formType: 'mobility', responses: { painScore: 4 } },
    });
    await repository.createVersion('pat-1', 'mobility-initial', 2, ACTOR, {
      visible: { formType: 'mobility', responses: { painScore: 2 } },
    });

    const versions = await repository.listVersions('pat-1', 'mobility-initial');
    expect(versions.map((v) => v.visible.responses)).toEqual([{ painScore: 4 }, { painScore: 2 }]);
  });
});
