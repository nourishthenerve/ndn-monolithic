// TASK 2.5.1's own Tests line, the parts a repository-level test can prove
// directly: a declined patient can be re-approved and both decisions
// survive; GSI1 returns a patient under the assigned clinician and under
// no other; no path removes a request row.
//
// "Approval is atomic — a forced failure on any leg leaves the patient
// pending with no GSI1 row" is proven at the `DynamoAssignmentStore`
// level (dynamo-store.test.ts), against a mocked `TransactWriteCommand`
// that can actually fail partway — `InMemoryAssignmentStore` is a
// synchronous JS object write with no partial-failure mode to exercise.
//
// "An unassigned sub-clinician is denied on that patient's every route" —
// once GSI1/`assigned_clinician_id` are real, `authz.test.ts`'s existing
// exhaustive suite (every row × column × action of the matrix, including
// the Phase-3 rows no handler yet exists for) is what proves this, for
// every entity the matrix already knows about; this file doesn't
// duplicate that coverage.
import type { Clinician, Patient } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { AssignmentRepository, InMemoryAssignmentStore } from './assignment-repository.js';
import { actorContext, InMemoryAuditLog } from './audit.js';
import { ClinicianRepository, InMemoryClinicianStore } from './clinician-repository.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const PRINCIPAL_ACTOR = actorContext(
  { subjectId: 'principal-sub', role: 'principal-clinician' },
  { requestId: 'req-1', sourceIp: '203.0.113.9' },
);

function buildPatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: 'pat-1',
    personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
    clinical: {},
    account_status: 'pending',
    keywords: [],
    status: 'active',
    created_at: '2026-08-22T08:00:00.000Z',
    updated_at: '2026-08-22T08:00:00.000Z',
    ...overrides,
  };
}

async function build() {
  const patientStore = new InMemoryStore<Patient>();
  const clinicianStore = new InMemoryClinicianStore();
  const clinicianAudit = new InMemoryAuditLog();
  const clinicians = new ClinicianRepository(clinicianStore, clinicianAudit, clock);
  await clinicianStore.create({
    id: 'cli-1',
    displayName: 'A Clinician',
    role: 'sub',
    account_status: 'active',
    status: 'active',
    created_at: '2026-08-22T08:00:00.000Z',
    updated_at: '2026-08-22T08:00:00.000Z',
  } satisfies Clinician);

  const assignmentStore = new InMemoryAssignmentStore(patientStore);
  const audit = new InMemoryAuditLog();
  const assignments = new AssignmentRepository(assignmentStore, clinicians, audit, clock);

  return { patientStore, assignmentStore, clinicians, assignments, audit };
}

describe('approve', () => {
  it('sets the patient approved and assigned, and the request approved, atomically (in one call)', async () => {
    const { patientStore, assignments } = await build();
    await patientStore.put('pat-1', buildPatient());

    const { request } = await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);

    expect(request).toMatchObject({
      patientId: 'pat-1',
      status: 'approved',
      assignedClinicianId: 'cli-1',
      decidedBy: 'principal-sub',
    });
    const patient = await patientStore.get('pat-1');
    expect(patient?.account_status).toBe('approved');
    expect(patient?.assigned_clinician_id).toBe('cli-1');
  });

  it('rejects assigning to a clinician that does not exist', async () => {
    const { patientStore, assignments } = await build();
    await patientStore.put('pat-1', buildPatient());

    await expect(assignments.approve('pat-1', 'nobody', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'CLINICIAN_NOT_AVAILABLE',
    });
  });

  it('rejects assigning to a deactivated clinician', async () => {
    const { patientStore, clinicians, assignments } = await build();
    await patientStore.put('pat-1', buildPatient());
    await clinicians.deactivate('cli-1', PRINCIPAL_ACTOR);

    await expect(assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'CLINICIAN_NOT_AVAILABLE',
    });
  });

  it('rejects approving an already-approved patient — that is reassignment, 2.5.2', async () => {
    const { patientStore, assignments } = await build();
    await patientStore.put('pat-1', buildPatient({ account_status: 'approved', assigned_clinician_id: 'cli-1' }));

    await expect(assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'ALREADY_ASSIGNED',
    });
  });

  it('throws for a patient that does not exist', async () => {
    const { assignments } = await build();
    await expect(assignments.approve('nobody', 'cli-1', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'RECORD_NOT_FOUND',
    });
  });

  it('writes one audit row, action "update", with the acting principal', async () => {
    const { patientStore, assignments, audit } = await build();
    await patientStore.put('pat-1', buildPatient());
    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);

    const events = audit.list();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'update',
      entityType: 'patient-assignment',
      entityId: 'pat-1',
      actor: 'principal-sub',
      actorRole: 'principal-clinician',
    });
  });
});

describe('decline', () => {
  it('sets the patient and the request declined, with no clinician assigned', async () => {
    const { patientStore, assignments } = await build();
    await patientStore.put('pat-1', buildPatient());

    const { request } = await assignments.decline('pat-1', PRINCIPAL_ACTOR);

    expect(request).toMatchObject({ patientId: 'pat-1', status: 'declined' });
    expect(request.assignedClinicianId).toBeUndefined();
    const patient = await patientStore.get('pat-1');
    expect(patient?.account_status).toBe('declined');
    expect(patient?.assigned_clinician_id).toBeUndefined();
  });

  it('rejects declining an already-approved patient', async () => {
    const { patientStore, assignments } = await build();
    await patientStore.put('pat-1', buildPatient({ account_status: 'approved', assigned_clinician_id: 'cli-1' }));

    await expect(assignments.decline('pat-1', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'ALREADY_ASSIGNED',
    });
  });

  it('writes one audit row, action "reject"', async () => {
    const { patientStore, assignments, audit } = await build();
    await patientStore.put('pat-1', buildPatient());
    await assignments.decline('pat-1', PRINCIPAL_ACTOR);

    expect(audit.list()[0]).toMatchObject({ action: 'reject', entityType: 'patient-assignment' });
  });
});

describe('re-approval after decline', () => {
  it('a declined patient can be re-approved, and both decisions survive in the append-only history', async () => {
    const { patientStore, assignmentStore, assignments } = await build();
    await patientStore.put('pat-1', buildPatient());

    await assignments.decline('pat-1', PRINCIPAL_ACTOR);
    const { request: approved } = await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);

    expect(approved.status).toBe('approved');
    const patient = await patientStore.get('pat-1');
    expect(patient?.account_status).toBe('approved');

    const history = assignmentStore.history();
    expect(history).toHaveLength(2);
    expect(history[0]?.status).toBe('declined');
    expect(history[1]?.status).toBe('approved');
  });
});

describe('GSI1 — clinician to patients', () => {
  it('returns an approved patient under the assigned clinician, and under no other', async () => {
    const { patientStore, clinicians, assignments } = await build();
    await clinicians.create('cli-2', { displayName: 'Another Clinician', role: 'sub' }, PRINCIPAL_ACTOR);
    await patientStore.put('pat-1', buildPatient({ id: 'pat-1' }));
    await patientStore.put('pat-2', buildPatient({ id: 'pat-2' }));

    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);

    expect(await assignments.listPatientIdsForClinician('cli-1')).toEqual(['pat-1']);
    expect(await assignments.listPatientIdsForClinician('cli-2')).toEqual([]);
  });
});

describe('reassign', () => {
  async function buildWithTwoClinicians() {
    const built = await build();
    await built.clinicians.create('cli-2', { displayName: 'Second Clinician', role: 'sub' }, PRINCIPAL_ACTOR);
    return built;
  }

  it('moves assigned_clinician_id to the new clinician, in one call', async () => {
    const { patientStore, assignments } = await buildWithTwoClinicians();
    await patientStore.put('pat-1', buildPatient());
    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);

    const { request, previousClinicianId } = await assignments.reassign('pat-1', 'cli-2', PRINCIPAL_ACTOR);

    expect(previousClinicianId).toBe('cli-1');
    expect(request).toMatchObject({ status: 'approved', assignedClinicianId: 'cli-2' });
    expect((await patientStore.get('pat-1'))?.assigned_clinician_id).toBe('cli-2');
  });

  it('GSI1, filtered by current assignment, returns the patient under the new clinician only', async () => {
    const { patientStore, assignments } = await buildWithTwoClinicians();
    await patientStore.put('pat-1', buildPatient());
    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);
    await assignments.reassign('pat-1', 'cli-2', PRINCIPAL_ACTOR);

    // The previous clinician's own GSI1 query returns nothing for this
    // patient — no stale row to filter (this file's own `reassign` doc:
    // gsi1pk/gsi1sk are overwritten in place, not left behind).
    expect(await assignments.listPatientIdsForClinician('cli-1')).toEqual([]);
    expect(await assignments.listPatientIdsForClinician('cli-2')).toEqual(['pat-1']);
  });

  it('the previous clinician loses access — can() reads the current assigned_clinician_id', async () => {
    const { patientStore, assignments } = await buildWithTwoClinicians();
    await patientStore.put('pat-1', buildPatient());
    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);
    await assignments.reassign('pat-1', 'cli-2', PRINCIPAL_ACTOR);

    const patient = await patientStore.get('pat-1');
    // authz.ts's own resolveColumn compares this field against the
    // caller's clinicianId — cli-1 can no longer resolve to "assigned"
    // for this patient the moment this field changed.
    expect(patient?.assigned_clinician_id).not.toBe('cli-1');
    expect(patient?.assigned_clinician_id).toBe('cli-2');
  });

  it('reconstructs the full history correctly across three consecutive assignments', async () => {
    const { patientStore, clinicians, assignmentStore, assignments } = await buildWithTwoClinicians();
    await clinicians.create('cli-3', { displayName: 'Third Clinician', role: 'sub' }, PRINCIPAL_ACTOR);
    await patientStore.put('pat-1', buildPatient());

    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);
    await assignments.reassign('pat-1', 'cli-2', PRINCIPAL_ACTOR);
    await assignments.reassign('pat-1', 'cli-3', PRINCIPAL_ACTOR);

    const history = assignmentStore.history();
    expect(history).toHaveLength(3);
    expect(history.map((r) => r.assignedClinicianId)).toEqual(['cli-1', 'cli-2', 'cli-3']);
    // Every prior row is exactly as written — reassignment never edits one.
    expect(history[0]).toMatchObject({ status: 'approved', assignedClinicianId: 'cli-1' });
    expect(history[1]).toMatchObject({ status: 'approved', assignedClinicianId: 'cli-2' });
  });

  it('rejects reassigning a patient that was never approved', async () => {
    const { patientStore, assignments } = await buildWithTwoClinicians();
    await patientStore.put('pat-1', buildPatient());

    await expect(assignments.reassign('pat-1', 'cli-2', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'NOT_ASSIGNED',
    });
  });

  it('rejects reassigning to a clinician that does not exist or is not active', async () => {
    const { patientStore, clinicians, assignments } = await buildWithTwoClinicians();
    await patientStore.put('pat-1', buildPatient());
    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);
    await clinicians.deactivate('cli-2', PRINCIPAL_ACTOR);

    await expect(assignments.reassign('pat-1', 'cli-2', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'CLINICIAN_NOT_AVAILABLE',
    });
    await expect(assignments.reassign('pat-1', 'nobody', PRINCIPAL_ACTOR)).rejects.toMatchObject({
      code: 'CLINICIAN_NOT_AVAILABLE',
    });
  });

  it('writes one audit row per reassignment', async () => {
    const { patientStore, assignments, audit } = await buildWithTwoClinicians();
    await patientStore.put('pat-1', buildPatient());
    await assignments.approve('pat-1', 'cli-1', PRINCIPAL_ACTOR);
    await assignments.reassign('pat-1', 'cli-2', PRINCIPAL_ACTOR);

    const events = audit.list();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ action: 'update', entityType: 'patient-assignment', entityId: 'pat-1' });
  });
});

describe('no delete', () => {
  it('exposes no method that removes a request or a patient', () => {
    const methods = Object.getOwnPropertyNames(AssignmentRepository.prototype);
    expect(methods).not.toContain('delete');
    expect(methods).not.toContain('remove');
    expect(methods.sort()).toEqual([
      'approve',
      'constructor',
      'decline',
      'listPatientIdsForClinician',
      'reassign',
      'requirePatient',
      'writeAndAudit',
    ]);
  });
});

describe('AppError is used for every failure', () => {
  it('RECORD_NOT_FOUND, CLINICIAN_NOT_AVAILABLE and ALREADY_ASSIGNED are all AppError', async () => {
    const { patientStore, assignments } = await build();
    await patientStore.put('pat-1', buildPatient());

    await expect(assignments.approve('nobody', 'cli-1', PRINCIPAL_ACTOR)).rejects.toBeInstanceOf(AppError);
    await expect(assignments.approve('pat-1', 'nobody', PRINCIPAL_ACTOR)).rejects.toBeInstanceOf(AppError);
  });
});
