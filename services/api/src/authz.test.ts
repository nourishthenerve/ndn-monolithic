// TASK 2.1.1: the matrix is asserted exhaustively, not by sample.
//
// DOC_TABLE below is an *independent* transcription of
// docs/plan/04-data-model-rbac.md's RBAC table — the doc's cells, verbatim,
// markdown and all. It is deliberately NOT derived from authz-matrix.ts:
// the point is that widening a cell there fails a named test here rather
// than passing silently, which it could not do if both read the same const.
// When the doc changes, both copies change, and the diff shows it twice.
import type { Action, FieldSet, Principal, Resource, Role } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import type { MatrixColumn, MatrixRow } from './authz-matrix.js';
import { RBAC_MATRIX } from './authz-matrix.js';
import { can } from './authz.js';

// prettier-ignore
const DOC_TABLE: Readonly<Record<MatrixRow, Readonly<Record<MatrixColumn, string>>>> = {
  //                            | Patient (own)      | Patient (other) | Sub-clinician (assigned) | Sub-clinician (unassigned) | Principal                 |
  'Own profile':              { 'Patient (own)': 'R U',            'Patient (other)': '—', 'Sub-clinician (assigned)': 'R U',              'Sub-clinician (unassigned)': '—',   Principal: 'R U' },
  'Patient profile':          { 'Patient (own)': 'R U (self)',     'Patient (other)': '—', 'Sub-clinician (assigned)': 'R U',              'Sub-clinician (unassigned)': '—',   Principal: 'R U' },
  'Patient assignment':       { 'Patient (own)': '—',              'Patient (other)': '—', 'Sub-clinician (assigned)': '—',                'Sub-clinician (unassigned)': '—',   Principal: 'C R U' },
  'Diagnosis / care plan':    { 'Patient (own)': '**R**',          'Patient (other)': '—', 'Sub-clinician (assigned)': 'C R U',            'Sub-clinician (unassigned)': '—',   Principal: 'C R U' },
  'Assessment — `visible{}`': { 'Patient (own)': 'R',              'Patient (other)': '—', 'Sub-clinician (assigned)': 'C R U',            'Sub-clinician (unassigned)': '—',   Principal: 'R' },
  'Assessment — `private{}`': { 'Patient (own)': '**—**',          'Patient (other)': '**—**', 'Sub-clinician (assigned)': 'C R U',        'Sub-clinician (unassigned)': '**—**', Principal: 'R' },
  Appointments:               { 'Patient (own)': 'R',              'Patient (other)': '—', 'Sub-clinician (assigned)': 'C R U',            'Sub-clinician (unassigned)': '—',   Principal: 'R' },
  'Content assignment':       { 'Patient (own)': 'R',              'Patient (other)': '—', 'Sub-clinician (assigned)': 'C R U',            'Sub-clinician (unassigned)': '—',   Principal: 'R' },
  Messages:                   { 'Patient (own)': 'C R (own thread)', 'Patient (other)': '—', 'Sub-clinician (assigned)': 'R (own patients)', 'Sub-clinician (unassigned)': '—', Principal: 'R' },
  'Clinician accounts':       { 'Patient (own)': '—',              'Patient (other)': '—', 'Sub-clinician (assigned)': '—',                'Sub-clinician (unassigned)': '—',   Principal: 'C R U (deactivate only)' },
  'Audit log':                { 'Patient (own)': '—',              'Patient (other)': '—', 'Sub-clinician (assigned)': '—',                'Sub-clinician (unassigned)': '—',   Principal: 'R' },
  'Content item':             { 'Patient (own)': '—',              'Patient (other)': '—', 'Sub-clinician (assigned)': 'C R U',            'Sub-clinician (unassigned)': 'C R U', Principal: 'C R U' },
  'Testimonial moderation':   { 'Patient (own)': '—',              'Patient (other)': '—', 'Sub-clinician (assigned)': 'C R U',            'Sub-clinician (unassigned)': 'C R U', Principal: 'C R U' },
  Workshop:                   { 'Patient (own)': '—',              'Patient (other)': '—', 'Sub-clinician (assigned)': 'C R U',            'Sub-clinician (unassigned)': 'C R U', Principal: 'C R U' },
};

const CELL_LETTERS: Record<string, Action> = { C: 'create', R: 'read', U: 'update' };

/**
 * Reads the doc's own cell notation. Markdown emphasis and the in-cell
 * relationship qualifiers are presentation — the relationship is what
 * picks the column, so "R U (self)" is an `R U` cell in the `own` column.
 */
function parseCell(cell: string): readonly Action[] {
  const stripped = cell
    .replace(/\*/g, '')
    .replace(/\([^)]*\)/g, '')
    .trim();
  if (stripped === '—') {
    return [];
  }
  return stripped.split(/\s+/).map((letter) => {
    const action = CELL_LETTERS[letter];
    if (!action) {
      throw new Error(`unrecognised cell notation "${cell}" in DOC_TABLE`);
    }
    return action;
  });
}

const ROWS = Object.keys(DOC_TABLE) as MatrixRow[];
const COLUMNS: readonly MatrixColumn[] = [
  'Patient (own)',
  'Patient (other)',
  'Sub-clinician (assigned)',
  'Sub-clinician (unassigned)',
  'Principal',
];
const ACTIONS: readonly Action[] = ['create', 'read', 'update'];

const ROW_ENTITY_TYPES: Readonly<Record<MatrixRow, string>> = {
  'Own profile': 'own-profile',
  'Patient profile': 'patient-profile',
  'Patient assignment': 'patient-assignment',
  'Diagnosis / care plan': 'diagnosis',
  'Assessment — `visible{}`': 'assessment',
  'Assessment — `private{}`': 'assessment',
  Appointments: 'appointment',
  'Content assignment': 'content-assignment',
  Messages: 'message',
  'Clinician accounts': 'clinician-account',
  'Audit log': 'audit',
  'Content item': 'content-item',
  'Testimonial moderation': 'testimonial-moderation',
  Workshop: 'workshop',
};

const ROW_FIELD_SETS: Partial<Readonly<Record<MatrixRow, FieldSet>>> = {
  'Assessment — `visible{}`': 'visible',
  'Assessment — `private{}`': 'private',
};

const PATIENT: Principal = {
  subjectId: 'sub-patient-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'PAT#1',
};

const SUB_CLINICIAN: Principal = {
  subjectId: 'sub-clinician-1',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'CLI#1',
};

const PRINCIPAL_CLINICIAN: Principal = {
  subjectId: 'sub-clinician-9',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'CLI#9',
};

function principalFor(column: MatrixColumn): Principal {
  switch (column) {
    case 'Patient (own)':
    case 'Patient (other)':
      return PATIENT;
    case 'Sub-clinician (assigned)':
    case 'Sub-clinician (unassigned)':
      return SUB_CLINICIAN;
    case 'Principal':
      return PRINCIPAL_CLINICIAN;
  }
}

/**
 * The resource that puts `principalFor(column)` in that column. The
 * `Principal` column's resource names a *different* patient and a
 * *different* clinician on purpose: the doc gives the principal clinician
 * one column, so relationship must not move them out of it.
 */
function resourceFor(row: MatrixRow, column: MatrixColumn): Resource {
  const base = { entityType: ROW_ENTITY_TYPES[row], fieldSet: ROW_FIELD_SETS[row] };
  switch (column) {
    case 'Patient (own)':
      return { ...base, ownerPatientId: 'PAT#1' };
    case 'Patient (other)':
      return { ...base, ownerPatientId: 'PAT#2' };
    case 'Sub-clinician (assigned)':
      return { ...base, assignedClinicianId: 'CLI#1' };
    case 'Sub-clinician (unassigned)':
      return { ...base, assignedClinicianId: 'CLI#2' };
    case 'Principal':
      return { ...base, ownerPatientId: 'PAT#2', assignedClinicianId: 'CLI#1' };
  }
}

describe('RBAC_MATRIX transcribes docs/plan/04-data-model-rbac.md', () => {
  it('has exactly the doc’s rows, and no others', () => {
    expect(Object.keys(RBAC_MATRIX).sort()).toEqual([...ROWS].sort());
  });

  it('has exactly the doc’s columns in every row, and no others', () => {
    for (const row of ROWS) {
      expect(Object.keys(RBAC_MATRIX[row]).sort()).toEqual([...COLUMNS].sort());
    }
  });

  it('grants nothing outside create/read/update in any cell', () => {
    for (const row of ROWS) {
      for (const column of COLUMNS) {
        for (const action of RBAC_MATRIX[row][column]) {
          expect(ACTIONS).toContain(action);
        }
      }
    }
  });
});

describe('can() — every cell of the RBAC matrix, one assertion each', () => {
  for (const row of ROWS) {
    for (const column of COLUMNS) {
      const allowedActions = parseCell(DOC_TABLE[row][column]);
      for (const action of ACTIONS) {
        const expectAllow = allowedActions.includes(action);
        it(`${row} × ${column} × ${action} → ${expectAllow ? 'allow' : 'deny'}`, () => {
          const decision = can(principalFor(column), action, resourceFor(row, column));
          expect(decision.allowed).toBe(expectAllow);
          if (decision.allowed) {
            expect(decision.row).toBe(row);
            expect(decision.column).toBe(column);
          }
        });
      }
    }
  }
});

describe('deny by default', () => {
  it('denies an unrecognised entity type, even to the principal clinician', () => {
    const decision = can(PRINCIPAL_CLINICIAN, 'read', { entityType: 'billing-export' });
    expect(decision).toEqual({ allowed: false, reason: 'unknown-entity-type' });
  });

  it('denies an unrecognised role', () => {
    const impostor: Principal = { ...PRINCIPAL_CLINICIAN, role: 'admin' as Role };
    const decision = can(impostor, 'read', { entityType: 'audit' });
    expect(decision).toEqual({ allowed: false, reason: 'unknown-role' });
  });

  it('denies an assessment lookup that does not say which half it wants', () => {
    const decision = can(SUB_CLINICIAN, 'read', {
      entityType: 'assessment',
      assignedClinicianId: 'CLI#1',
    });
    expect(decision).toEqual({ allowed: false, reason: 'missing-field-set' });
  });

  it.each<[string, Principal]>([
    ['a patient with no patientId', { ...PATIENT, patientId: undefined }],
    ['a patient with an empty patientId', { ...PATIENT, patientId: '' }],
    ['a patient carrying a clinicianId', { ...PATIENT, clinicianId: 'CLI#1' }],
    ['a sub-clinician with no clinicianId', { ...SUB_CLINICIAN, clinicianId: undefined }],
    ['a sub-clinician carrying a patientId', { ...SUB_CLINICIAN, patientId: 'PAT#1' }],
    [
      'a principal clinician with no clinicianId',
      { ...PRINCIPAL_CLINICIAN, clinicianId: undefined },
    ],
    ['a principal clinician carrying a patientId', { ...PRINCIPAL_CLINICIAN, patientId: 'PAT#1' }],
  ])('denies %s — the identity link must match the role', (_label, principal) => {
    const decision = can(principal, 'read', { entityType: 'own-profile', ownerPatientId: 'PAT#1' });
    expect(decision).toEqual({ allowed: false, reason: 'malformed-principal' });
  });

  it('routes both diagnosis and care-plan entity types to the one doc row', () => {
    for (const entityType of ['diagnosis', 'care-plan']) {
      const decision = can(SUB_CLINICIAN, 'update', { entityType, assignedClinicianId: 'CLI#1' });
      expect(decision).toEqual({
        allowed: true,
        row: 'Diagnosis / care plan',
        column: 'Sub-clinician (assigned)',
      });
    }
  });
});

describe('accountStatus gates before role does', () => {
  const inoperative = ['pending', 'declined', 'suspended', 'deactivated'] as const;

  it.each(inoperative)('a %s patient may read their own profile', (accountStatus) => {
    const decision = can({ ...PATIENT, accountStatus }, 'read', {
      entityType: 'own-profile',
      ownerPatientId: 'PAT#1',
    });
    expect(decision.allowed).toBe(true);
  });

  it.each(inoperative)('a %s patient may not update their own profile', (accountStatus) => {
    const decision = can({ ...PATIENT, accountStatus }, 'update', {
      entityType: 'own-profile',
      ownerPatientId: 'PAT#1',
    });
    expect(decision).toEqual({ allowed: false, reason: 'account-not-active' });
  });

  it.each(inoperative)(
    'a %s patient may read nothing else — not even their own care plan',
    (accountStatus) => {
      const decision = can({ ...PATIENT, accountStatus }, 'read', {
        entityType: 'care-plan',
        ownerPatientId: 'PAT#1',
      });
      expect(decision).toEqual({ allowed: false, reason: 'account-not-active' });
    },
  );

  it('a deactivated clinician may read their own profile and create nothing', () => {
    const deactivated: Principal = { ...SUB_CLINICIAN, accountStatus: 'deactivated' };
    expect(
      can(deactivated, 'read', { entityType: 'own-profile', assignedClinicianId: 'CLI#1' }).allowed,
    ).toBe(true);
    expect(
      can(deactivated, 'create', { entityType: 'diagnosis', assignedClinicianId: 'CLI#1' }),
    ).toEqual({ allowed: false, reason: 'account-not-active' });
  });

  it('leaves the matrix the last word — a suspended patient still cannot read another profile', () => {
    const decision = can({ ...PATIENT, accountStatus: 'suspended' }, 'read', {
      entityType: 'own-profile',
      ownerPatientId: 'PAT#2',
    });
    expect(decision).toEqual({ allowed: false, reason: 'matrix-denies' });
  });
});

describe('R-09: a patient reaches no private assessment field, in any relationship', () => {
  for (const column of ['Patient (own)', 'Patient (other)'] as const) {
    for (const action of ACTIONS) {
      it(`${column} × ${action} on a private assessment → deny`, () => {
        const decision = can(PATIENT, action, resourceFor('Assessment — `private{}`', column));
        expect(decision).toEqual({ allowed: false, reason: 'matrix-denies' });
      });
    }
  }
});

describe('a sub-clinician reaches nothing belonging to a patient they are not assigned', () => {
  // TASK 2.5.4's three rows are deliberately excluded: "unassigned" for a
  // patient-relationship row means "someone else's patient," but Content
  // item/Testimonial moderation/Workshop carry no patient relationship at
  // all, so every sub-clinician is "unassigned" on them by construction —
  // that column is where 2.5.4's "any clinician" grant actually lives, not
  // a denial this test's premise applies to. See docs/plan/04-data-model-rbac.md's
  // own note on those three rows.
  const PATIENT_RELATIONSHIP_ROWS = ROWS.filter(
    (row) => row !== 'Content item' && row !== 'Testimonial moderation' && row !== 'Workshop',
  );
  for (const row of PATIENT_RELATIONSHIP_ROWS) {
    it(`${row} → deny, for every action`, () => {
      for (const action of ACTIONS) {
        const decision = can(SUB_CLINICIAN, action, resourceFor(row, 'Sub-clinician (unassigned)'));
        expect(decision.allowed).toBe(false);
      }
    });
  }
});

describe('there is no delete', () => {
  it('does not compile when asked to authorise one', () => {
    // @ts-expect-error TASK 2.1.1 step 4: Action has no 'delete' member, so
    // "authorise a delete" is a compile error, not a policy decision. If
    // this line ever stops erroring, someone has widened Action — see
    // 00-conventions.md's prohibition and C-03.
    const decision = can(PRINCIPAL_CLINICIAN, 'delete', { entityType: 'audit' });
    expect(decision.allowed).toBe(false);
  });
});
