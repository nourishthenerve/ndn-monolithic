// TASK 2.1.2 (R-09): the chokepoint's own suite. R-09 is the register's
// only **Critical** risk and its mitigation names the number — "100%
// coverage on the boundary" — so projection.ts carries a per-file
// threshold of its own in vitest.config.ts and this file is what has to
// keep it green.
//
// The negative cases are the point. Every `does NOT see private` assertion
// below is one of docs/plan/04-data-model-rbac.md's `—` cells, and the
// type-level `@ts-expect-error` blocks are the part a reviewer cannot skip:
// they fail `pnpm -r typecheck`, not `pnpm test`.
import type { Principal, Resource } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { AppError } from './errors.js';
import {
  containsPrivateField,
  PRIVATE_REDACTION,
  projectAllFor,
  projectFor,
  redactPrivateText,
  serialiseResponse,
  unprojected,
  type Projected,
} from './projection.js';

interface Assessment {
  readonly id: string;
  readonly visible: { readonly painScore: number };
  readonly private: { readonly clinicianNote: string };
}

const ASSESSMENT: Assessment = {
  id: 'ASSESS#1',
  visible: { painScore: 4 },
  private: { clinicianNote: 'query non-organic presentation' },
};

/** The assessment resource every principal below is aimed at. */
const ASSESSMENT_RESOURCE: Resource = {
  entityType: 'assessment',
  ownerPatientId: 'PAT#1',
  assignedClinicianId: 'CLI#1',
};

const ASSIGNED_SUB_CLINICIAN: Principal = {
  subjectId: 'sub-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'CLI#1',
};

const UNASSIGNED_SUB_CLINICIAN: Principal = {
  subjectId: 'sub-2',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'CLI#2',
};

const PRINCIPAL_CLINICIAN: Principal = {
  subjectId: 'sub-3',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'CLI#9',
};

const OWNING_PATIENT: Principal = {
  subjectId: 'sub-4',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'PAT#1',
};

const OTHER_PATIENT: Principal = {
  subjectId: 'sub-5',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'PAT#2',
};

describe('projectFor — who sees private{}', () => {
  it('keeps visible{} and private{} for the assigned sub-clinician', () => {
    expect(projectFor(ASSIGNED_SUB_CLINICIAN, ASSESSMENT, ASSESSMENT_RESOURCE)).toEqual(ASSESSMENT);
  });

  it('keeps visible{} and private{} for the principal clinician', () => {
    expect(projectFor(PRINCIPAL_CLINICIAN, ASSESSMENT, ASSESSMENT_RESOURCE)).toEqual(ASSESSMENT);
  });

  it.each([
    ['the owning patient', OWNING_PATIENT],
    ['any other patient', OTHER_PATIENT],
    ['an unassigned sub-clinician', UNASSIGNED_SUB_CLINICIAN],
  ])('strips private{} for %s', (_label, principal) => {
    const projected = projectFor(principal, ASSESSMENT, ASSESSMENT_RESOURCE);
    expect(projected).toEqual({ id: 'ASSESS#1', visible: { painScore: 4 } });
    expect(containsPrivateField(projected)).toBe(false);
  });

  it('strips private{} on an entity the data model gives no private half — even for the principal clinician', () => {
    // Deny by default: `can()` only splits visible/private on the two
    // assessment rows, so asking it about a patient-profile's private half
    // would otherwise collapse into "may you read a patient profile?".
    const record = { id: 'PAT#1', private: { note: 'never reachable' } };
    const projected = projectFor(PRINCIPAL_CLINICIAN, record, {
      entityType: 'patient-profile',
      ownerPatientId: 'PAT#1',
      assignedClinicianId: 'CLI#9',
    });
    expect(projected).toEqual({ id: 'PAT#1' });
  });

  it('denies an inoperative clinician the private half', () => {
    const suspended: Principal = { ...ASSIGNED_SUB_CLINICIAN, accountStatus: 'deactivated' };
    expect(projectFor(suspended, ASSESSMENT, ASSESSMENT_RESOURCE)).toEqual({
      id: 'ASSESS#1',
      visible: { painScore: 4 },
    });
  });
});

describe('projectFor — shape of the walk', () => {
  it('strips private{} nested below the top level and inside arrays', () => {
    const nested = {
      id: 'ASSESS#2',
      sections: [
        { title: 'gait', visible: { score: 2 }, private: { note: 'a' } },
        { title: 'tone', visible: { score: 3 }, private: { note: 'b' } },
      ],
      meta: { review: { private: { note: 'c' }, due: '2026-09-01' } },
    };
    expect(projectFor(OWNING_PATIENT, nested, ASSESSMENT_RESOURCE)).toEqual({
      id: 'ASSESS#2',
      sections: [
        { title: 'gait', visible: { score: 2 } },
        { title: 'tone', visible: { score: 3 } },
      ],
      meta: { review: { due: '2026-09-01' } },
    });
  });

  it('leaves scalars, nulls and prototype-less objects alone', () => {
    const record = {
      id: 'ASSESS#3',
      count: 0,
      note: null,
      flag: false,
      bag: Object.assign(Object.create(null) as object, { keep: 'yes', private: { note: 'no' } }),
    };
    expect(projectFor(OWNING_PATIENT, record, ASSESSMENT_RESOURCE)).toEqual({
      id: 'ASSESS#3',
      count: 0,
      note: null,
      flag: false,
      bag: { keep: 'yes' },
    });
  });

  it('treats a non-plain object as a leaf rather than rebuilding it', () => {
    // Nothing in this data model stores a Date (00-conventions.md: every
    // timestamp is an ISO string), and walking one would silently turn it
    // into `{}`. Class instances get the same treatment.
    const at = new Date('2026-08-21T00:00:00.000Z');
    const projected = projectFor(OWNING_PATIENT, { at }, ASSESSMENT_RESOURCE);
    expect(projected.at).toBeInstanceOf(Date);
    expect(projected.at).toBe(at);
  });

  it('projects every element of a list through the same decision', () => {
    const list = [ASSESSMENT, { ...ASSESSMENT, id: 'ASSESS#4' }];
    expect(projectAllFor(OWNING_PATIENT, list, ASSESSMENT_RESOURCE)).toEqual([
      { id: 'ASSESS#1', visible: { painScore: 4 } },
      { id: 'ASSESS#4', visible: { painScore: 4 } },
    ]);
    expect(projectAllFor(ASSIGNED_SUB_CLINICIAN, list, ASSESSMENT_RESOURCE)).toEqual(list);
  });
});

describe('containsPrivateField', () => {
  it.each([
    ['a top-level private key', { private: {} }, true],
    ['a nested private key', { a: { b: { private: {} } } }, true],
    ['a private key inside an array', { a: [{ private: {} }] }, true],
    ['a clean record', { a: { b: 1 }, c: [{ d: 'e' }] }, false],
    ['a clean array', [{ a: 1 }, { b: 2 }], false],
    ['a scalar', 'private', false],
    ['null', null, false],
    ['a Date', new Date('2026-08-21T00:00:00.000Z'), false],
  ])('detects %s', (_label, value, expected) => {
    expect(containsPrivateField(value)).toBe(expected);
  });
});

describe('redactPrivateText', () => {
  it('leaves a message with no private field untouched', () => {
    expect(redactPrivateText('Assessment ASSESS#1 not found')).toBe(
      'Assessment ASSESS#1 not found',
    );
  });

  it('drops everything from the private key onward', () => {
    const message = `rejected ${JSON.stringify(ASSESSMENT)}`;
    expect(redactPrivateText(message)).toBe(
      `rejected {"id":"ASSESS#1","visible":{"painScore":4},${PRIVATE_REDACTION}`,
    );
    expect(redactPrivateText(message)).not.toContain('non-organic');
  });
});

describe('AppError (errors.ts) — the message exit', () => {
  it('carries no private content when built from a record', () => {
    const error = new AppError('BAD_ASSESSMENT', `could not save ${JSON.stringify(ASSESSMENT)}`);
    expect(error.message).not.toContain('non-organic');
    expect(error.message).toContain(PRIVATE_REDACTION);
    expect(error.code).toBe('BAD_ASSESSMENT');
  });

  it('leaves an ordinary message alone', () => {
    expect(new AppError('RECORD_NOT_FOUND', 'Patient PAT#1 not found').message).toBe(
      'Patient PAT#1 not found',
    );
  });
});

describe('serialiseResponse', () => {
  it('serialises a projected record and plain scalars', () => {
    const body = serialiseResponse({
      item: projectFor(ASSIGNED_SUB_CLINICIAN, ASSESSMENT, ASSESSMENT_RESOURCE),
      count: 1,
      error: null,
    });
    expect(JSON.parse(body)).toEqual({ item: ASSESSMENT, count: 1, error: null });
  });

  it('serialises a projected list', () => {
    const body = serialiseResponse({
      items: projectAllFor(OWNING_PATIENT, [ASSESSMENT], ASSESSMENT_RESOURCE),
    });
    expect(JSON.parse(body)).toEqual({ items: [{ id: 'ASSESS#1', visible: { painScore: 4 } }] });
  });

  it('does not accept an unprojected record — a compile error, not a test failure', () => {
    // @ts-expect-error a raw record has never been through projectFor
    serialiseResponse({ item: ASSESSMENT });
    // @ts-expect-error a record straight off a repository read is no better
    serialiseResponse({ item: unprojected(ASSESSMENT) });
    // @ts-expect-error nor is a raw list
    serialiseResponse({ items: [ASSESSMENT] });
    // A projected record is the only record shape that compiles here.
    const ok: Projected<Partial<Assessment>> = projectFor(
      OWNING_PATIENT,
      ASSESSMENT,
      ASSESSMENT_RESOURCE,
    );
    expect(serialiseResponse({ item: ok })).toContain('ASSESS#1');
  });
});
