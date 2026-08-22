// TASK 2.2.2 step 5. The property under test is negative and structural:
// a handler cannot end up with a `Principal` that the authorizer did not
// produce, and cannot end up with a half-formed one either.
import { describe, expect, it } from 'vitest';

import { AppError } from './errors.js';
import { optionalPrincipal, requirePrincipal } from './request-principal.js';

function eventWith(lambda: unknown) {
  return { requestContext: { authorizer: { lambda } } };
}

const PATIENT_CONTEXT = {
  subjectId: 'sub-1',
  role: 'patient',
  accountStatus: 'approved',
  patientId: 'sub-1',
};

const CLINICIAN_CONTEXT = {
  subjectId: 'sub-2',
  role: 'principal-clinician',
  accountStatus: 'active',
  clinicianId: 'cli-2',
};

describe('requirePrincipal returns what the authorizer put there', () => {
  it('parses a patient context', () => {
    expect(requirePrincipal(eventWith(PATIENT_CONTEXT))).toEqual(PATIENT_CONTEXT);
  });

  it('parses a clinician context', () => {
    expect(requirePrincipal(eventWith(CLINICIAN_CONTEXT))).toEqual(CLINICIAN_CONTEXT);
  });

  it.each(['pending', 'approved', 'declined', 'suspended'])(
    'accepts a patient in %s — the matrix decides what that permits, not this function',
    (accountStatus) => {
      expect(requirePrincipal(eventWith({ ...PATIENT_CONTEXT, accountStatus })).accountStatus).toBe(
        accountStatus,
      );
    },
  );
});

describe('requirePrincipal throws UNAUTHENTICATED rather than improvising', () => {
  function expectUnauthenticated(lambda: unknown) {
    try {
      requirePrincipal(eventWith(lambda));
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('UNAUTHENTICATED');
      return;
    }
    throw new Error('expected requirePrincipal to throw');
  }

  it('throws when the route is not behind the authorizer at all', () => {
    // The important case: a handler that forgot to be protected fails on
    // its first request rather than running as nobody.
    try {
      requirePrincipal({});
    } catch (error) {
      expect((error as AppError).code).toBe('UNAUTHENTICATED');
      return;
    }
    throw new Error('expected requirePrincipal to throw');
  });

  it.each([
    ['an empty context', {}],
    ['a null context', null],
    ['a string context', 'principal-clinician'],
    ['an unknown role', { ...PATIENT_CONTEXT, role: 'admin' }],
    ['an unknown account status', { ...PATIENT_CONTEXT, accountStatus: 'superuser' }],
    ['an empty subjectId', { ...PATIENT_CONTEXT, subjectId: '' }],
    ['a missing role', { subjectId: 'sub-1', accountStatus: 'approved', patientId: 'sub-1' }],
  ])('throws for %s', (_name, lambda) => {
    expectUnauthenticated(lambda);
  });

  it('throws when a patient carries a clinicianId', () => {
    expectUnauthenticated({ ...PATIENT_CONTEXT, clinicianId: 'cli-9' });
  });

  it('throws when a clinician carries a patientId', () => {
    expectUnauthenticated({ ...CLINICIAN_CONTEXT, patientId: 'pat-9' });
  });

  it('throws when a patient has no patientId to be related by', () => {
    expectUnauthenticated({ subjectId: 'sub-1', role: 'patient', accountStatus: 'approved' });
  });

  it('throws when a clinician has no clinicianId', () => {
    expectUnauthenticated({ subjectId: 'sub-2', role: 'sub-clinician', accountStatus: 'active' });
  });

  it('says nothing about what would have been accepted', () => {
    try {
      requirePrincipal(eventWith({ ...PATIENT_CONTEXT, role: 'admin' }));
    } catch (error) {
      const message = (error as AppError).message;
      expect(message).toBe('no verified principal on this request');
      expect(message).not.toContain('admin');
      expect(message).not.toContain('patient');
      return;
    }
    throw new Error('expected requirePrincipal to throw');
  });
});

describe('optionalPrincipal', () => {
  it('returns the principal when there is one', () => {
    expect(optionalPrincipal(eventWith(CLINICIAN_CONTEXT))).toEqual(CLINICIAN_CONTEXT);
  });

  it('returns undefined instead of throwing, for the handlers whose 401 is a response', () => {
    expect(optionalPrincipal({})).toBeUndefined();
    expect(optionalPrincipal(eventWith({ role: 'patient' }))).toBeUndefined();
  });
});
