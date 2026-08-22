// TASK 2.2.3's Tests line, the two that are about the record: every status
// transition is recorded, and no transition removes one.
import type { Patient } from '@ndn/shared-types';
import { describe, expect, it } from 'vitest';

import { actorContext, InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';
import { notificationRecipientFor, PatientRepository, type PatientTransition } from './patient-repository.js';
import { InMemoryStore } from './store.js';

const SUB = 'a1b2c3d4-5678-90ab-cdef-000000000001';

const PATIENT_ACTOR = actorContext(
  { subjectId: SUB, role: 'patient' },
  { requestId: 'req-1', sourceIp: '203.0.113.7' },
);
const CLINICIAN_ACTOR = actorContext(
  { subjectId: 'cli-1', role: 'principal-clinician' },
  { requestId: 'req-2', sourceIp: '203.0.113.8' },
);

// 00-conventions.md: "time is injectable — no test reads the wall clock."
const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

function build() {
  const store = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  return { store, audit, patients: new PatientRepository(store, audit, clock) };
}

const REGISTRATION = {
  subjectId: SUB,
  personal: { fullName: 'A Patient', email: 'patient@example.com', marketingOptIn: false },
};

describe('registration', () => {
  it('creates a pending record keyed by the Cognito sub', async () => {
    const { patients } = build();
    const patient = await patients.register(REGISTRATION, PATIENT_ACTOR);

    expect(patient.id).toBe(SUB);
    expect(patient.account_status).toBe('pending');
    // The row is active; the *account* is pending. Two fields, two facts.
    expect(patient.status).toBe('active');
  });

  it('splits what the patient gave us from anything with a clinical basis', async () => {
    const { patients } = build();
    const patient = await patients.register(REGISTRATION, PATIENT_ACTOR);

    expect(patient.personal).toEqual({
      fullName: 'A Patient',
      email: 'patient@example.com',
      marketingOptIn: false,
    });
    expect(patient.clinical).toEqual({});
  });

  it('writes nothing clinical during self-registration beyond the two declared fields', async () => {
    // The type is the enforcement — `PatientRegistration` has no other
    // clinical field to pass — so this asserts the runtime agrees.
    const { patients } = build();
    const patient = await patients.register(
      { ...REGISTRATION, clinical: { referralSource: 'GP', presentingCondition: 'stated' } },
      PATIENT_ACTOR,
    );

    expect(Object.keys(patient.clinical).sort()).toEqual(['presentingCondition', 'referralSource']);
  });

  // Cognito re-invokes a failed trigger with the same event.
  it('is idempotent under replay: two invocations leave one record and one audit row', async () => {
    const { patients, audit } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.register(REGISTRATION, PATIENT_ACTOR);

    expect(audit.list().filter((event) => event.action === 'create')).toHaveLength(1);
  });

  it('does not overwrite an approved record when the trigger replays late', async () => {
    // The dangerous replay: Cognito retries after a clinician has already
    // approved. A second `create` would reset the account to `pending`.
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.transition(SUB, 'approve', CLINICIAN_ACTOR);
    const replayed = await patients.register(REGISTRATION, PATIENT_ACTOR);

    expect(replayed.account_status).toBe('approved');
  });
});

describe('transitions', () => {
  const CASES: [PatientTransition, Patient['account_status'], string][] = [
    ['approve', 'approved', 'update'],
    ['decline', 'declined', 'reject'],
    ['suspend', 'suspended', 'update'],
  ];

  it.each(CASES)('%s moves the account to %s and audits it as %s', async (
    transition,
    expectedStatus,
    expectedAction,
  ) => {
    const { patients, audit } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    const patient = await patients.transition(SUB, transition, CLINICIAN_ACTOR);

    expect(patient.account_status).toBe(expectedStatus);
    const last = audit.list().at(-1);
    expect(last?.action).toBe(expectedAction);
    expect(last?.entityType).toBe('patient');
    expect(last?.entityId).toBe(SUB);
  });

  it('records which clinician acted, not merely that someone did', async () => {
    const { patients, audit } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.transition(SUB, 'approve', CLINICIAN_ACTOR);

    expect(audit.list().at(-1)?.actor).toBe('cli-1');
    expect(audit.list().at(-1)?.actorRole).toBe('principal-clinician');
  });

  it.each(CASES)('leaves the record readable after %s', async (transition) => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.transition(SUB, transition, CLINICIAN_ACTOR);

    const found = await patients.findById(SUB);
    expect(found).toBeDefined();
    expect(found?.personal.fullName).toBe('A Patient');
  });

  it('never touches record_status — a declined patient is not a deleted row', async () => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    const declined = await patients.transition(SUB, 'decline', CLINICIAN_ACTOR);

    expect(declined.account_status).toBe('declined');
    expect(declined.status).toBe('active');
  });

  it('can move a declined patient back to approved — the record was never gone', async () => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.transition(SUB, 'decline', CLINICIAN_ACTOR);
    const reapproved = await patients.transition(SUB, 'approve', CLINICIAN_ACTOR);

    expect(reapproved.account_status).toBe('approved');
  });

  it('throws rather than creating a record for an unknown patient', async () => {
    const { patients } = build();

    await expect(patients.transition('nobody', 'approve', CLINICIAN_ACTOR)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('exposes no method that removes a record', () => {
    // The structural half of "no path deletes a person". `Repository` has
    // no removal method to inherit and this class adds none.
    const methods = Object.getOwnPropertyNames(PatientRepository.prototype);
    expect(methods.sort()).toEqual(['constructor', 'findById', 'register', 'transition']);
  });
});

describe('notificationRecipientFor', () => {
  it('projects the fields the Notifier needs off personal{}, in every account status', async () => {
    const { patients } = build();
    const registered = await patients.register(REGISTRATION, PATIENT_ACTOR);
    const declined = await patients.transition(SUB, 'decline', CLINICIAN_ACTOR);

    expect(notificationRecipientFor(registered)).toEqual({
      id: SUB,
      email: 'patient@example.com',
      phone: undefined,
      marketingOptIn: false,
    });
    // A declined account's record is still fully readable (2.2.3's own
    // rule) — the Notifier's own guards decide whether to send, not this.
    expect(notificationRecipientFor(declined)).toEqual({
      id: SUB,
      email: 'patient@example.com',
      phone: undefined,
      marketingOptIn: false,
    });
  });
});
