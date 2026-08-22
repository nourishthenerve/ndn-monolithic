// TASK 2.2.3 step 3 and step 6: idempotence under Cognito's retries, and
// a confirmation email that says nothing about why the patient is here.
import type { Patient } from '@ndn/shared-types';
import { describe, expect, it, vi } from 'vitest';

import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { PatientRepository } from './patient-repository.js';
import {
  createPostConfirmationHandler,
  MissingSubjectError,
  POST_CONFIRMATION_SIGN_UP,
} from './post-confirmation.js';
import type { IntakeStore, RegistrationIntake } from './registration.js';
import { REGISTRATION_EMAIL_BODY, REGISTRATION_EMAIL_SUBJECT } from './ses-registration.js';
import { InMemoryStore } from './store.js';

const SUB = 'a1b2c3d4-5678-90ab-cdef-000000000001';
const EMAIL = 'patient@example.com';
const clock: Clock = { now: () => new Date('2026-08-22T09:00:00.000Z') };

const INTAKE: RegistrationIntake = {
  fullName: 'A Patient',
  email: EMAIL,
  phone: '+441234567890',
  marketingOptIn: true,
};

function event(overrides: Record<string, unknown> = {}) {
  return {
    triggerSource: POST_CONFIRMATION_SIGN_UP,
    request: { userAttributes: { sub: SUB, email: EMAIL } },
    ...overrides,
  };
}

function build(options: { intake?: RegistrationIntake } = {}) {
  const store = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  const patients = new PatientRepository(store, audit, clock);
  let held = options.intake;
  const intakeStore: IntakeStore = {
    put: async () => {},
    take: async () => {
      const value = held;
      held = undefined; // consumed, exactly as the Dynamo store does
      return value;
    },
  };
  const sendConfirmationEmail = vi.fn(async () => {});
  const lines: Record<string, unknown>[] = [];
  const handler = createPostConfirmationHandler({
    patients,
    intake: intakeStore,
    sendConfirmationEmail,
    log: (line) => lines.push(line),
  });
  return { handler, patients, audit, sendConfirmationEmail, lines };
}

describe('the trigger creates the record the authorizer needs', () => {
  it('writes a pending PAT# record keyed by the sub', async () => {
    const { handler, patients } = build({ intake: INTAKE });
    await handler(event());

    const patient = await patients.findById(SUB);
    expect(patient?.id).toBe(SUB);
    expect(patient?.account_status).toBe('pending');
  });

  it('fills personal{} from the intake row Cognito could not carry', async () => {
    const { handler, patients } = build({ intake: INTAKE });
    await handler(event());

    expect((await patients.findById(SUB))?.personal).toEqual({
      fullName: 'A Patient',
      email: EMAIL,
      phone: '+441234567890',
      marketingOptIn: true,
    });
  });

  it('prefers the address Cognito verified over the intake row copy', async () => {
    // They match in every ordinary flow. When they do not, the one the
    // patient proved they can read is the true one.
    const { handler, patients } = build({ intake: { ...INTAKE, email: 'typo@example.com' } });
    await handler(event());

    expect((await patients.findById(SUB))?.personal.email).toBe(EMAIL);
  });

  it('still creates a record when there is no intake row at all', async () => {
    // An account made outside POST /registrations — an operator in the
    // Cognito console. A pending record with a verified address beats a
    // confirmed account the authorizer denies forever.
    const { handler, patients, lines } = build();
    await handler(event());

    expect((await patients.findById(SUB))?.personal).toEqual({
      fullName: '',
      email: EMAIL,
      phone: undefined,
      marketingOptIn: false,
    });
    expect(lines.map((line) => line.event)).toContain('registration-intake-missing');
  });

  it('writes nothing clinical', async () => {
    const { handler, patients } = build({ intake: INTAKE });
    await handler(event());

    expect((await patients.findById(SUB))?.clinical).toEqual({});
  });
});

describe('idempotence, because Cognito retries', () => {
  it('leaves one record and one audit row after three identical invocations', async () => {
    const { handler, audit, patients } = build({ intake: INTAKE });
    await handler(event());
    await handler(event());
    await handler(event());

    expect(audit.list().filter((entry) => entry.action === 'create')).toHaveLength(1);
    expect((await patients.findById(SUB))?.personal.fullName).toBe('A Patient');
  });

  it('does not lose the name on replay, even though the intake row is consumed', async () => {
    // The subtle one: the second invocation finds no intake row. If
    // registration were not idempotent it would rewrite the record with an
    // empty name.
    const { handler, patients } = build({ intake: INTAKE });
    await handler(event());
    await handler(event());

    expect((await patients.findById(SUB))?.personal.fullName).toBe('A Patient');
  });
});

describe('what it refuses to do', () => {
  it('ignores a trigger that is not a sign-up confirmation', async () => {
    const { handler, patients } = build({ intake: INTAKE });
    await handler(event({ triggerSource: 'PostConfirmation_ConfirmForgotPassword' }));

    expect(await patients.findById(SUB)).toBeUndefined();
  });

  it.each([
    ['no sub', { email: EMAIL }],
    ['no email', { sub: SUB }],
    ['neither', {}],
  ])('throws rather than improvising a record when the event carries %s', async (_name, attrs) => {
    const { handler } = build({ intake: INTAKE });

    await expect(handler(event({ request: { userAttributes: attrs } }))).rejects.toBeInstanceOf(
      MissingSubjectError,
    );
  });

  it('returns the event unchanged, as a Cognito trigger must', async () => {
    const { handler } = build({ intake: INTAKE });
    const input = event();

    expect(await handler(input)).toBe(input);
  });
});

describe('the confirmation email', () => {
  it('is sent after the record exists, not before', async () => {
    const { handler, sendConfirmationEmail, patients } = build({ intake: INTAKE });
    let recordExistedAtSendTime = false;
    sendConfirmationEmail.mockImplementation(async () => {
      recordExistedAtSendTime = (await patients.findById(SUB)) !== undefined;
    });
    await handler(event());

    expect(sendConfirmationEmail).toHaveBeenCalledWith(EMAIL);
    expect(recordExistedAtSendTime).toBe(true);
  });

  it('does not fail the trigger when SES refuses — the account and record are already real', async () => {
    const { handler, sendConfirmationEmail, patients, lines } = build({ intake: INTAKE });
    sendConfirmationEmail.mockRejectedValue(new Error('MessageRejected'));

    await expect(handler(event())).resolves.toBeDefined();
    expect(await patients.findById(SUB)).toBeDefined();
    expect(lines.map((line) => line.event)).toContain('registration-email-failed');
  });

  it('has no name in the subject and no clinical language anywhere', async () => {
    // It lands in a mailbox this clinic does not control. A bystander must
    // not learn from a lock screen that someone is seeking neuro-rehab.
    const message = `${REGISTRATION_EMAIL_SUBJECT}\n${REGISTRATION_EMAIL_BODY}`.toLowerCase();

    for (const term of [
      'neuro',
      'rehab',
      'clinic',
      'clinician',
      'patient',
      'condition',
      'diagnosis',
      'referral',
      'appointment',
      'treatment',
      'therapy',
      'symptom',
    ]) {
      expect(message).not.toContain(term);
    }
    expect(REGISTRATION_EMAIL_SUBJECT.toLowerCase()).not.toContain('a patient');
  });

  it('logs the subject id and the status, and never the address', async () => {
    const { handler, lines } = build({ intake: INTAKE });
    await handler(event());

    expect(lines).toContainEqual({
      event: 'patient-registered',
      subjectId: SUB,
      accountStatus: 'pending',
    });
    expect(JSON.stringify(lines)).not.toContain(EMAIL);
    expect(JSON.stringify(lines)).not.toContain('A Patient');
  });
});
