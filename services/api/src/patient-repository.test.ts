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

  it('does not overwrite a transitioned record when the trigger replays late', async () => {
    // The dangerous replay: Cognito retries after a clinician has already
    // acted on the record. A second `create` would reset the account to
    // `pending`. (Approval itself moved to assignment-repository.ts at
    // 2.5.1 — `suspend` stands in here for "any transition already
    // applied", which is this test's actual point.)
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.transition(SUB, 'suspend', CLINICIAN_ACTOR);
    const replayed = await patients.register(REGISTRATION, PATIENT_ACTOR);

    expect(replayed.account_status).toBe('suspended');
  });
});

describe('transitions', () => {
  const CASES: [PatientTransition, Patient['account_status'], string][] = [
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
    await patients.transition(SUB, 'suspend', CLINICIAN_ACTOR);

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

  it('never touches record_status — a suspended patient is not a deleted row', async () => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    const suspended = await patients.transition(SUB, 'suspend', CLINICIAN_ACTOR);

    expect(suspended.account_status).toBe('suspended');
    expect(suspended.status).toBe('active');
  });

  it('throws rather than creating a record for an unknown patient', async () => {
    const { patients } = build();

    await expect(patients.transition('nobody', 'suspend', CLINICIAN_ACTOR)).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it('exposes no method that removes a record', () => {
    // The structural half of "no path deletes a person". `Repository` has
    // no removal method to inherit and this class adds none.
    const methods = Object.getOwnPropertyNames(PatientRepository.prototype);
    expect(methods.sort()).toEqual(['constructor', 'findById', 'register', 'transition', 'update']);
  });
});

describe('update (TASK 3.1.1)', () => {
  it('merges a personal{} patch into the existing sub-object, field by field', async () => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    const updated = await patients.update(SUB, PATIENT_ACTOR, { personal: { phone: '07700900000' } });

    // The fields the patch never mentioned survive untouched.
    expect(updated.personal).toEqual({
      fullName: 'A Patient',
      email: 'patient@example.com',
      phone: '07700900000',
      marketingOptIn: false,
    });
  });

  it('merges a clinical{} patch the same way, independent of personal{}', async () => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.update(SUB, CLINICIAN_ACTOR, {
      clinical: { referralSource: 'GP' },
    });
    const updated = await patients.update(SUB, CLINICIAN_ACTOR, {
      clinical: { presentingCondition: 'stated' },
    });

    expect(updated.clinical).toEqual({ referralSource: 'GP', presentingCondition: 'stated' });
  });

  it('can patch both halves in one call without either clobbering the other', async () => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    const updated = await patients.update(SUB, CLINICIAN_ACTOR, {
      personal: { phone: '07700900000' },
      clinical: { referralSource: 'GP' },
    });

    expect(updated.personal.phone).toBe('07700900000');
    expect(updated.clinical.referralSource).toBe('GP');
  });

  it('audits the update with the acting principal', async () => {
    const { patients, audit } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    await patients.update(SUB, CLINICIAN_ACTOR, { personal: { phone: '07700900000' } });

    const last = audit.list().at(-1);
    expect(last?.action).toBe('update');
    expect(last?.actor).toBe('cli-1');
    expect(last?.entityType).toBe('patient');
  });

  it('throws rather than creating a record for an unknown patient', async () => {
    const { patients } = build();

    await expect(
      patients.update('nobody', CLINICIAN_ACTOR, { personal: { phone: '0' } }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('leaves the row readable and its status untouched', async () => {
    const { patients } = build();
    await patients.register(REGISTRATION, PATIENT_ACTOR);
    const updated = await patients.update(SUB, PATIENT_ACTOR, { personal: { phone: '1' } });

    expect(updated.status).toBe('active');
    expect(updated.account_status).toBe('pending');
  });
});

describe('notificationRecipientFor', () => {
  it('projects the fields the Notifier needs off personal{}, in every account status', async () => {
    const { patients } = build();
    const registered = await patients.register(REGISTRATION, PATIENT_ACTOR);
    const suspended = await patients.transition(SUB, 'suspend', CLINICIAN_ACTOR);

    expect(notificationRecipientFor(registered)).toEqual({
      id: SUB,
      email: 'patient@example.com',
      phone: undefined,
      marketingOptIn: false,
    });
    // A suspended account's record is still fully readable (2.2.3's own
    // rule) — the Notifier's own guards decide whether to send, not this.
    expect(notificationRecipientFor(suspended)).toEqual({
      id: SUB,
      email: 'patient@example.com',
      phone: undefined,
      marketingOptIn: false,
    });
  });
});
