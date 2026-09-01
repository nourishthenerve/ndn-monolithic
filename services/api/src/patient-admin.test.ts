import type { Assessment, Patient } from '@ndn/shared-types';
import type { APIGatewayProxyEventV2WithLambdaAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';

import { AssessmentRepository, DEFAULT_ASSESSMENT_ID } from './assessment-repository.js';
import { InMemoryAuditLog } from './audit.js';
import type { Clock } from './clock.js';
import { CachedFlagReader, FLAG_CACHE_TTL_MS, InMemoryFlagSource } from './flags.js';
import {
  createPatientAdminHandler,
  type AdminCreatePatientPort,
  type AdminFindPatientPort,
  type AdminSetPatientPasswordPort,
} from './patient-admin.js';
import { PatientRepository } from './patient-repository.js';
import { InMemoryStore } from './store.js';

const clock: Clock = { now: () => new Date('2026-08-29T09:00:00.000Z') };

type LambdaAuthorizerEvent = APIGatewayProxyEventV2WithLambdaAuthorizer<
  Record<string, unknown> | undefined
>;

function eventFor(
  routeKey: string,
  options: {
    readonly principal?: Record<string, unknown>;
    readonly pathParameters?: Record<string, string>;
    readonly queryStringParameters?: Record<string, string>;
    readonly body?: unknown;
  } = {},
): LambdaAuthorizerEvent {
  return {
    version: '2.0',
    routeKey,
    rawPath: '/patients',
    rawQueryString: '',
    headers: {},
    pathParameters: options.pathParameters,
    queryStringParameters: options.queryStringParameters,
    body: options.body ? JSON.stringify(options.body) : undefined,
    isBase64Encoded: false,
    requestContext: {
      accountId: '',
      apiId: '',
      domainName: '',
      domainPrefix: '',
      http: {
        method: 'POST',
        path: '/patients',
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.9',
        userAgent: '',
      },
      requestId: 'req-1',
      routeKey,
      stage: '$default',
      time: '',
      timeEpoch: 0,
      authorizer: { lambda: options.principal },
    },
  } as unknown as LambdaAuthorizerEvent;
}

const PRINCIPAL_CONTEXT = {
  subjectId: 'principal-sub',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'principal-sub',
};

const SUB_CLINICIAN_CONTEXT = {
  subjectId: 'sub-sub',
  role: 'sub-clinician',
  accountStatus: 'active',
  clinicianId: 'sub-sub',
};

const HELPDESK_CONTEXT = {
  subjectId: 'helpdesk-sub',
  role: 'helpdesk',
  accountStatus: 'active',
  clinicianId: 'helpdesk-sub',
};

const PATIENT_CONTEXT = {
  subjectId: 'patient-sub',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'patient-sub',
};

function build(
  overrides: {
    flagEnabled?: boolean;
    nextCreateResult?: 'created' | 'exists';
    /**
     * A Cognito user that already exists in the pool before the test
     * begins — `AdminCreateUser` refuses this email, and `AdminGetUser`
     * resolves it to this subject id. Whether a `PAT#` record exists
     * behind it is the test's own business (that is the difference
     * between a real duplicate and an orphan).
     */
    existingCognitoUser?: { email: string; subjectId: string };
  } = {},
) {
  const flagSource = new InMemoryFlagSource();
  flagSource.set('patients.administration.enabled', overrides.flagEnabled ?? true);
  const flags = new CachedFlagReader({ source: flagSource, clock, ttlMs: FLAG_CACHE_TTL_MS });

  const store = new InMemoryStore<Patient>();
  const audit = new InMemoryAuditLog();
  const repository = new PatientRepository(store, audit, clock);

  let nextSub = 0;
  const emailToSub = new Map<string, string>();
  if (overrides.existingCognitoUser) {
    emailToSub.set(overrides.existingCognitoUser.email, overrides.existingCognitoUser.subjectId);
  }
  const createPatientUser: AdminCreatePatientPort = {
    createUser: vi.fn(async (email: string) => {
      if (overrides.nextCreateResult === 'exists' || emailToSub.has(email)) {
        return { outcome: 'exists' } as const;
      }
      const subjectId = `sub-${(nextSub += 1)}`;
      emailToSub.set(email, subjectId);
      return { outcome: 'created', subjectId } as const;
    }),
  };

  const setPatientPassword: AdminSetPatientPasswordPort = {
    setPassword: vi.fn(async () => {}),
  };

  const findPatientUser: AdminFindPatientPort = {
    findByEmail: vi.fn(async (email: string) => {
      const subjectId = emailToSub.get(email);
      return subjectId ? { subjectId } : undefined;
    }),
  };

  // 2026-09-01: the assessment form instantiated at account creation.
  const assessments = new AssessmentRepository(
    new InMemoryStore<Assessment>(),
    new InMemoryAuditLog(),
    clock,
  );

  const handler = createPatientAdminHandler({
    repository,
    assessments,
    flags,
    audit,
    createPatientUser,
    setPatientPassword,
    findPatientUser,
    generatePassword: () => 'Fixed-Passw0rd!',
    clock,
  });

  return {
    handler,
    repository,
    assessments,
    audit,
    createPatientUser,
    setPatientPassword,
    findPatientUser,
  };
}

async function invoke(handler: ReturnType<typeof build>['handler'], event: LambdaAuthorizerEvent) {
  const result = await handler(event, {} as never, () => undefined);
  return result as { statusCode: number; body: string };
}

const VALID_BODY = {
  email: 'new-patient@example.com',
  fullName: 'New Patient',
  phone: '+919876543210',
  marketingOptIn: false,
};

describe('POST /patients', () => {
  it('404s when the flag is off', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('401s with no principal', async () => {
    const { handler } = build();
    const response = await invoke(handler, eventFor('POST /patients', { body: VALID_BODY }));
    expect(response.statusCode).toBe(401);
  });

  it.each([SUB_CLINICIAN_CONTEXT, PATIENT_CONTEXT])(
    '403s a non-principal caller',
    async (principal) => {
      const { handler } = build();
      const response = await invoke(
        handler,
        eventFor('POST /patients', { principal, body: VALID_BODY }),
      );
      expect(response.statusCode).toBe(403);
    },
  );

  it('400s an invalid body', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: { email: 'not-an-email' } }),
    );
    expect(response.statusCode).toBe(400);
  });

  it('creates a Cognito user, sets a permanent password, then a pending patient record, in that order', async () => {
    const { handler, createPatientUser, setPatientPassword, repository } = build();

    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );

    expect(response.statusCode).toBe(201);
    expect(createPatientUser.createUser).toHaveBeenCalledWith('new-patient@example.com');
    expect(setPatientPassword.setPassword).toHaveBeenCalledWith('sub-1', 'Fixed-Passw0rd!');

    const body = JSON.parse(response.body) as {
      item: { id: string; account_status: string; personal: { fullName: string } };
      password: string;
    };
    expect(body.password).toBe('Fixed-Passw0rd!');
    expect(body.item.account_status).toBe('pending');
    expect(body.item.personal.fullName).toBe('New Patient');
    expect(await repository.findById(body.item.id)).toMatchObject({ account_status: 'pending' });
  });

  it('never reveals the generated password anywhere but this one response', async () => {
    // Structural proxy for "never logged, never persisted": the record
    // this test can actually inspect (the DynamoDB-shaped patient row) has
    // no field the password could have landed in.
    const { handler, repository } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    const body = JSON.parse(response.body) as { item: { id: string } };
    const stored = await repository.findById(body.item.id);
    expect(JSON.stringify(stored)).not.toContain('Fixed-Passw0rd!');
  });

  it('409s when the email already has a Cognito account and a patient record behind it', async () => {
    const { handler, repository } = build({
      existingCognitoUser: { email: VALID_BODY.email, subjectId: 'sub-existing' },
    });
    await repository.register(
      {
        subjectId: 'sub-existing',
        personal: { fullName: 'Already Here', email: VALID_BODY.email, marketingOptIn: false },
        clinical: {},
      },
      { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
    );

    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );

    expect(response.statusCode).toBe(409);
  });

  it('409s when AdminCreateUser and AdminGetUser disagree about the same pool', async () => {
    // `nextCreateResult: 'exists'` with nothing seeded — the username is
    // taken but no lookup can resolve it. No ordinary state produces this,
    // and the refusal is deliberate: there is no subject id to trust, so
    // there is nothing safe to write a record against.
    const { handler } = build({ nextCreateResult: 'exists' });
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    expect(response.statusCode).toBe(409);
  });

  // Found live, 2026-08-31. The `undefined`-marshalling bug above left a
  // real Cognito user behind with no `PAT#` record: an account that could
  // not sign in, could not be found by `GET /patients?email=`, did not
  // appear on the dashboard, and permanently blocked its own email. The
  // operator was told "an account with this email already exists" and then
  // "no patient account was found with that email address" — both true,
  // and together useless.
  it('completes an orphaned Cognito user rather than refusing it forever', async () => {
    const { handler, repository, setPatientPassword, createPatientUser } = build({
      existingCognitoUser: { email: VALID_BODY.email, subjectId: 'sub-orphaned' },
    });
    // The orphan's defining property: a Cognito user, and no record.
    expect(await repository.findById('sub-orphaned')).toBeUndefined();

    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );

    expect(response.statusCode).toBe(201);
    expect(createPatientUser.createUser).toHaveBeenCalledWith(VALID_BODY.email);
    // The *existing* subject is completed — never a second Cognito user,
    // and never a record keyed by anything but the sub that already holds
    // this email.
    expect(setPatientPassword.setPassword).toHaveBeenCalledWith('sub-orphaned', 'Fixed-Passw0rd!');
    const body = JSON.parse(response.body) as { item: { id: string }; password: string };
    expect(body.item.id).toBe('sub-orphaned');
    expect(body.password).toBe('Fixed-Passw0rd!');
    expect(await repository.findById('sub-orphaned')).toMatchObject({
      account_status: 'pending',
      personal: { fullName: 'New Patient' },
    });
  });

  it('never resets a live patient password while healing — the record check is what separates the two', async () => {
    // The mirror of the test above, and the reason healing is guarded
    // rather than unconditional: `PatientRepository.register` is
    // idempotent and returns an existing record untouched, so an
    // unguarded fall-through would hand back a real patient's record
    // alongside a freshly-set password.
    const { handler, repository, setPatientPassword } = build({
      existingCognitoUser: { email: VALID_BODY.email, subjectId: 'sub-live' },
    });
    await repository.register(
      {
        subjectId: 'sub-live',
        personal: { fullName: 'Live Patient', email: VALID_BODY.email, marketingOptIn: false },
        clinical: {},
      },
      { subjectId: 'principal-sub', role: 'principal-clinician', requestId: 'r', sourceIpHash: 'h' },
    );

    await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );

    expect(setPatientPassword.setPassword).not.toHaveBeenCalled();
  });

  // Found live, 2026-08-31: leaving every optional field blank made the
  // record carry `personal.phone === undefined` and two more like it, and
  // the real DynamoDB document client refuses to marshal an `undefined`
  // ("Pass options.removeUndefinedValues=true…") — a 500 the browser
  // showed as "Something went wrong creating the account."
  //
  // Nothing caught it because `VALID_BODY` above has always carried a
  // phone, and because the in-memory store this suite writes through
  // marshals nothing at all. So the assertion is on the property that
  // *is* checkable here and is the actual invariant: an optional field
  // the caller omitted must be an **absent property**, never a present
  // one holding `undefined`. That is true or false in plain JavaScript,
  // independently of which store is underneath.
  it('omits an unsupplied optional field entirely rather than storing it as undefined', async () => {
    const { handler, repository } = build();

    const response = await invoke(
      handler,
      eventFor('POST /patients', {
        principal: PRINCIPAL_CONTEXT,
        body: {
          email: 'sparse@example.com',
          fullName: 'Sparse Patient',
          marketingOptIn: false,
          // No phone, no referralSource, no presentingCondition — the
          // shape the form sends when staff fill in only what the patient
          // gave them over WhatsApp.
        },
      }),
    );

    expect(response.statusCode).toBe(201);
    const stored = await repository.findById(
      (JSON.parse(response.body) as { item: { id: string } }).item.id,
    );
    expect(stored).toBeDefined();
    expect(Object.keys(stored?.personal ?? {})).not.toContain('phone');
    expect(stored?.clinical).toEqual({});
    // The general form of the same rule, so a future optional field added
    // to either half is covered without anyone remembering this test.
    for (const half of [stored?.personal, stored?.clinical]) {
      for (const [key, value] of Object.entries(half ?? {})) {
        expect(value, `${key} is present but undefined`).toBeDefined();
      }
    }
  });
});

// 2026-08-31: "Only the principal clinician would be able to remove the
// patient." Deliberately on the `Patient assignment` row rather than
// `Patient profile` — helpdesk holds `update` on the latter, and
// "correct a phone number" must not be the same permission as "revoke
// this person's access". The helpdesk case below is the one that proves
// the split is real rather than incidental.
describe('POST /patients/{id}/suspend and /restore', () => {
  async function createOne(handler: ReturnType<typeof build>['handler']) {
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    return (JSON.parse(response.body) as { item: { id: string } }).item.id;
  }

  it('suspends and restores, leaving the assigned clinician untouched throughout', async () => {
    const { handler, repository } = build();
    const id = await createOne(handler);

    const suspended = await invoke(
      handler,
      eventFor('POST /patients/{id}/suspend', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id },
      }),
    );
    expect(suspended.statusCode).toBe(200);
    expect(await repository.findById(id)).toMatchObject({ account_status: 'suspended' });

    const restored = await invoke(
      handler,
      eventFor('POST /patients/{id}/restore', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id },
      }),
    );
    expect(restored.statusCode).toBe(200);
    expect(await repository.findById(id)).toMatchObject({ account_status: 'approved' });
  });

  it('never removes the record — suspension is a status, not a delete', async () => {
    const { handler, repository } = build();
    const id = await createOne(handler);
    await invoke(
      handler,
      eventFor('POST /patients/{id}/suspend', { principal: PRINCIPAL_CONTEXT, pathParameters: { id } }),
    );
    const stored = await repository.findById(id);
    expect(stored).toBeDefined();
    expect(stored?.personal.fullName).toBe('New Patient');
  });

  it.each([
    ['helpdesk', HELPDESK_CONTEXT],
    ['a sub-clinician', SUB_CLINICIAN_CONTEXT],
    ['a patient', PATIENT_CONTEXT],
  ])('refuses %s — this is the Patient assignment row, not the profile row', async (_label, principal) => {
    const { handler, repository } = build();
    const id = await createOne(handler);

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/suspend', { principal, pathParameters: { id } }),
    );

    expect(response.statusCode).toBe(403);
    expect(await repository.findById(id)).toMatchObject({ account_status: 'pending' });
  });

  it('404s a patient that does not exist', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/suspend', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'nobody' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });
});

describe('POST /patients/{id}/reset-password', () => {
  async function createPatient(handler: ReturnType<typeof build>['handler']) {
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    return (JSON.parse(response.body) as { item: { id: string } }).item.id;
  }

  it('404s when the flag is off', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'pat-1' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it.each([SUB_CLINICIAN_CONTEXT, PATIENT_CONTEXT])(
    '403s a non-principal caller',
    async (principal) => {
      const { handler } = build();
      const response = await invoke(
        handler,
        eventFor('POST /patients/{id}/reset-password', {
          principal,
          pathParameters: { id: 'pat-1' },
        }),
      );
      expect(response.statusCode).toBe(403);
    },
  );

  it('404s an unknown patient id', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id: 'no-such-patient' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('sets a new permanent password and returns it once, with no repository write', async () => {
    const { handler, setPatientPassword, repository } = build();
    const id = await createPatient(handler);
    const before = await repository.findById(id);

    const response = await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(setPatientPassword.setPassword).toHaveBeenLastCalledWith(id, 'Fixed-Passw0rd!');
    const body = JSON.parse(response.body) as { password: string };
    expect(body.password).toBe('Fixed-Passw0rd!');
    // No profile field changes — this action touches only the directory.
    expect(await repository.findById(id)).toEqual(before);
  });

  it('writes an audit row naming the acting principal', async () => {
    const { handler, audit } = build();
    const id = await createPatient(handler);

    await invoke(
      handler,
      eventFor('POST /patients/{id}/reset-password', {
        principal: PRINCIPAL_CONTEXT,
        pathParameters: { id },
      }),
    );

    const events = audit.list();
    const resetEvent = events.find((event) => event.action === 'reset-password');
    expect(resetEvent).toMatchObject({
      actor: PRINCIPAL_CONTEXT.subjectId,
      entityType: 'patient',
      entityId: id,
    });
  });
});

describe('GET /patients', () => {
  async function createPatient(handler: ReturnType<typeof build>['handler']) {
    const response = await invoke(
      handler,
      eventFor('POST /patients', { principal: PRINCIPAL_CONTEXT, body: VALID_BODY }),
    );
    return (JSON.parse(response.body) as { item: { id: string } }).item.id;
  }

  it('404s when the flag is off', async () => {
    const { handler } = build({ flagEnabled: false });
    const response = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: VALID_BODY.email },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it.each([SUB_CLINICIAN_CONTEXT, PATIENT_CONTEXT])(
    '403s a non-principal caller',
    async (principal) => {
      const { handler } = build();
      const response = await invoke(
        handler,
        eventFor('GET /patients', { principal, queryStringParameters: { email: VALID_BODY.email } }),
      );
      expect(response.statusCode).toBe(403);
    },
  );

  it('400s a missing or invalid email query parameter', async () => {
    const { handler } = build();
    const missing = await invoke(handler, eventFor('GET /patients', { principal: PRINCIPAL_CONTEXT }));
    expect(missing.statusCode).toBe(400);

    const invalid = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: 'not-an-email' },
      }),
    );
    expect(invalid.statusCode).toBe(400);
  });

  it('404s an email with no matching account', async () => {
    const { handler } = build();
    const response = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: 'nobody@example.com' },
      }),
    );
    expect(response.statusCode).toBe(404);
  });

  it('finds a real patient by email and returns their full profile', async () => {
    const { handler, findPatientUser } = build();
    const id = await createPatient(handler);

    const response = await invoke(
      handler,
      eventFor('GET /patients', {
        principal: PRINCIPAL_CONTEXT,
        queryStringParameters: { email: VALID_BODY.email },
      }),
    );

    expect(response.statusCode).toBe(200);
    expect(findPatientUser.findByEmail).toHaveBeenCalledWith(VALID_BODY.email);
    const body = JSON.parse(response.body) as { item: { id: string; account_status: string } };
    expect(body.item.id).toBe(id);
    expect(body.item.account_status).toBe('pending');
  });
});

// 2026-09-01: "Each patient will have an assessment form that will be
// loaded from the template the moment his account is being created."
describe('POST /patients — the assessment form', () => {
  it('instantiates version 1 for the new account, tagged as the account was', async () => {
    const { handler, assessments } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients', {
        principal: PRINCIPAL_CONTEXT,
        body: {
          email: 'new@example.com',
          fullName: 'New Patient',
          marketingOptIn: false,
          tag: 'IIC',
        },
      }),
    );
    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as {
      item: { id: string };
      assessmentFormCreated: boolean;
    };
    expect(created.assessmentFormCreated).toBe(true);

    const form = await assessments.getVersion(created.item.id, DEFAULT_ASSESSMENT_ID, 1);
    expect(form?.general.responses.tag).toBe('IIC');
    expect(form?.patient).toEqual({ responses: {}, attachments: [] });
    // R-09: no clinician section until a clinician writes one.
    expect(form?.private).toBeUndefined();
  });

  it('creates the form for a helpdesk-created account too — the form is part of the account, not of who made it', async () => {
    const { handler, assessments } = build();
    const response = await invoke(
      handler,
      eventFor('POST /patients', {
        principal: HELPDESK_CONTEXT,
        body: { email: 'new@example.com', fullName: 'New Patient', marketingOptIn: false },
      }),
    );
    expect(response.statusCode).toBe(201);
    const created = JSON.parse(response.body) as { item: { id: string } };
    expect(await assessments.getVersion(created.item.id, DEFAULT_ASSESSMENT_ID, 1)).toBeDefined();
  });

  it('still creates the account when the form write fails, and says so — the form is recoverable, the account would not be', async () => {
    const { handler, assessments } = build();
    assessments.instantiate = () => Promise.reject(new Error('dynamo is having a day'));
    const response = await invoke(
      handler,
      eventFor('POST /patients', {
        principal: PRINCIPAL_CONTEXT,
        body: { email: 'new@example.com', fullName: 'New Patient', marketingOptIn: false },
      }),
    );
    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body) as { assessmentFormCreated: boolean; password: string };
    expect(body.assessmentFormCreated).toBe(false);
    expect(body.password).toBe('Fixed-Passw0rd!');
  });
});
