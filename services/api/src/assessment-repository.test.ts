// 2026-09-01: rewritten for the four-section record. What this file proves
// is the property the whole design rests on — **a section a caller cannot
// read is a section they cannot destroy by omitting it** — plus the
// idempotence of template instantiation.
import type { Assessment } from '@ndn/shared-types';
import { ASSESSMENT_TAG_FIELD_ID } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { AssessmentRepository, DEFAULT_ASSESSMENT_ID } from './assessment-repository.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const CLINICIAN = actorContext(
  { subjectId: 'sub-1', role: 'sub-clinician' },
  { requestId: 'req-1', sourceIp: '198.51.100.7' },
);
const PATIENT_ACTOR = actorContext(
  { subjectId: 'pat-1', role: 'patient' },
  { requestId: 'req-2', sourceIp: '198.51.100.8' },
);

function build() {
  const store = new InMemoryStore<Assessment>();
  const audit = new InMemoryAuditLog();
  return { repository: new AssessmentRepository(store, audit, clock), store, audit };
}

describe('AssessmentRepository.instantiate', () => {
  it('writes version 1 with every section present and empty', async () => {
    const { repository } = build();
    const form = await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, {});
    expect(form.version).toBe(1);
    expect(form.general).toEqual({ responses: {}, attachments: [] });
    expect(form.patient).toEqual({ responses: {}, attachments: [] });
    expect(form.calendar).toEqual({ responses: {}, attachments: [] });
  });

  it('leaves the clinician section absent, not present and empty — R-09 keeps "nobody wrote here" distinguishable from "someone wrote nothing"', async () => {
    const { repository } = build();
    const form = await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, {});
    expect(form.private).toBeUndefined();
    expect(Object.hasOwn(form, 'private')).toBe(false);
  });

  it('seeds the general section with the tag the account was created with', async () => {
    const { repository } = build();
    const form = await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, {
      tag: 'IIC',
    });
    expect(form.general.responses[ASSESSMENT_TAG_FIELD_ID]).toBe('IIC');
  });

  it('is idempotent — a retried account creation returns the existing form rather than overwriting a filled-in one', async () => {
    const { repository, audit } = build();
    await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, { tag: 'NDN' });
    const first = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(first!, 2, CLINICIAN, {
      general: { responses: { preferredName: 'Sam' } },
    });

    const again = await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, {
      tag: 'NDN',
    });
    expect(again.version).toBe(1);
    // Two writes happened (instantiate + patch), never three: the second
    // instantiate wrote nothing at all.
    expect(audit.list()).toHaveLength(2);
    const latest = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(latest?.general.responses.preferredName).toBe('Sam');
  });

  it('keeps two patients\' forms apart even under the same form id', async () => {
    const { repository } = build();
    await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, { tag: 'IIC' });
    await repository.instantiate('pat-2', DEFAULT_ASSESSMENT_ID, CLINICIAN, { tag: 'NDN' });
    const one = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    const two = await repository.latest('pat-2', DEFAULT_ASSESSMENT_ID);
    expect(one?.general.responses[ASSESSMENT_TAG_FIELD_ID]).toBe('IIC');
    expect(two?.general.responses[ASSESSMENT_TAG_FIELD_ID]).toBe('NDN');
  });
});

describe('AssessmentRepository.applySectionPatch', () => {
  async function seeded() {
    const built = build();
    await built.repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, { tag: 'NDN' });
    // A clinician fills in every section, so there is something in each
    // for a later patch to preserve or destroy.
    const v1 = await built.repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await built.repository.applySectionPatch(v1!, 2, CLINICIAN, {
      general: { responses: { preferredName: 'Sam' } },
      patient: { responses: { goals: 'walk unaided' } },
      private: { responses: { clinicianImpression: 'guarded' } },
      calendar: { responses: { schedulingNotes: 'mornings only' } },
    });
    return built;
  }

  it('carries every unnamed section forward untouched — the property that makes section permissions and append-only versioning compatible', async () => {
    const { repository } = await seeded();
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);

    // The patient edits general info, and names nothing else. They cannot
    // read `private{}`, so they could not have sent it back — and it
    // survives regardless.
    await repository.applySectionPatch(v2!, 3, PATIENT_ACTOR, {
      general: { responses: { preferredName: 'Samantha' } },
    });

    const v3 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(v3?.general.responses.preferredName).toBe('Samantha');
    expect(v3?.private?.responses.clinicianImpression).toBe('guarded');
    expect(v3?.patient.responses.goals).toBe('walk unaided');
    expect(v3?.calendar.responses.schedulingNotes).toBe('mornings only');
  });

  it('merges responses rather than replacing them — an omitted field says nothing about that field', async () => {
    const { repository } = await seeded();
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v2!, 3, CLINICIAN, {
      general: { responses: { dateOfBirth: '1980-01-01' } },
    });
    const v3 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(v3?.general.responses).toEqual({
      [ASSESSMENT_TAG_FIELD_ID]: 'NDN',
      preferredName: 'Sam',
      dateOfBirth: '1980-01-01',
    });
  });

  it('leaves the previous version untouched — versions are append-only', async () => {
    const { repository } = await seeded();
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v2!, 3, CLINICIAN, {
      general: { responses: { preferredName: 'Changed' } },
    });
    const stillV2 = await repository.getVersion('pat-1', DEFAULT_ASSESSMENT_ID, 2);
    expect(stillV2?.general.responses.preferredName).toBe('Sam');
  });

  it('appends attachments and stamps them server-side — a caller cannot forge who uploaded what, or when', async () => {
    const { repository } = await seeded();
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v2!, 3, CLINICIAN, {
      general: {
        addAttachments: [
          {
            key: 'assessments/pat-1/intake-v1/general/abc-scan.pdf',
            fileName: 'scan.pdf',
            contentType: 'application/pdf',
          },
        ],
      },
    });
    const v3 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(v3?.general.attachments).toEqual([
      {
        key: 'assessments/pat-1/intake-v1/general/abc-scan.pdf',
        fileName: 'scan.pdf',
        contentType: 'application/pdf',
        uploadedAt: '2026-08-22T09:00:00.000Z',
        uploadedBy: 'sub-1',
      },
    ]);
  });

  it('never drops an attachment already on the record — the patch appends, it does not supply a list', async () => {
    const { repository } = await seeded();
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v2!, 3, CLINICIAN, {
      general: {
        addAttachments: [
          { key: 'assessments/pat-1/intake-v1/general/a-one.pdf', fileName: 'one.pdf', contentType: 'application/pdf' },
        ],
      },
    });
    const v3 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v3!, 4, CLINICIAN, {
      general: {
        addAttachments: [
          { key: 'assessments/pat-1/intake-v1/general/b-two.pdf', fileName: 'two.pdf', contentType: 'application/pdf' },
        ],
      },
    });
    const v4 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(v4?.general.attachments.map((a) => a.fileName)).toEqual(['one.pdf', 'two.pdf']);
  });

  it('keeps `private{}` absent when it was absent and the patch does not name it', async () => {
    const { repository } = build();
    await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, {});
    const v1 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v1!, 2, PATIENT_ACTOR, {
      general: { responses: { preferredName: 'Sam' } },
    });
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(Object.hasOwn(v2!, 'private')).toBe(false);
  });

  it('creates `private{}` the first time a patch names it', async () => {
    const { repository } = build();
    await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, {});
    const v1 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v1!, 2, CLINICIAN, {
      private: { responses: { clinicianImpression: 'first note' } },
    });
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(v2?.private?.responses.clinicianImpression).toBe('first note');
  });

  it('refuses to overwrite a version that already exists — the 409 two concurrent writers get', async () => {
    const { repository } = await seeded();
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v2!, 3, CLINICIAN, { general: { responses: {} } });
    await expect(
      repository.applySectionPatch(v2!, 3, CLINICIAN, { general: { responses: {} } }),
    ).rejects.toThrow(AppError);
  });

  it('audits every version against the actor who wrote it', async () => {
    const { repository, audit } = await seeded();
    const v2 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v2!, 3, PATIENT_ACTOR, {
      general: { responses: { preferredName: 'Sam' } },
    });
    expect(audit.list().at(-1)).toEqual(
      expect.objectContaining({
        action: 'create',
        entityType: 'assessment',
        entityId: 'pat-1#intake-v1#v3',
        actor: 'pat-1',
      }),
    );
  });
});

describe('AssessmentRepository.latest / listVersions', () => {
  it('returns undefined for a form that has never been instantiated', async () => {
    const { repository } = build();
    expect(await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID)).toBeUndefined();
    expect(await repository.listVersions('pat-1', DEFAULT_ASSESSMENT_ID)).toEqual([]);
  });

  it('returns versions oldest-first, and `latest` as the newest of them', async () => {
    const { repository } = build();
    await repository.instantiate('pat-1', DEFAULT_ASSESSMENT_ID, CLINICIAN, {});
    const v1 = await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID);
    await repository.applySectionPatch(v1!, 2, CLINICIAN, { general: { responses: {} } });
    const versions = await repository.listVersions('pat-1', DEFAULT_ASSESSMENT_ID);
    expect(versions.map((v) => v.version)).toEqual([1, 2]);
    expect((await repository.latest('pat-1', DEFAULT_ASSESSMENT_ID))?.version).toBe(2);
  });
});
