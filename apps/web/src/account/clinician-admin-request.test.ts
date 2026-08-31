import { describe, expect, it } from 'vitest';

import { buildCreateClinicianRequestBody } from './clinician-admin-request.js';
import type { CreateClinicianFormFields } from './clinician-admin-request.js';

function fields(overrides: Partial<CreateClinicianFormFields> = {}): CreateClinicianFormFields {
  return {
    email: 'clinician@example.com',
    displayName: 'Test Clinician',
    role: 'sub',
    password: '',
    ...overrides,
  };
}

describe('buildCreateClinicianRequestBody', () => {
  it('trims email and displayName, and passes role through unchanged', () => {
    const body = buildCreateClinicianRequestBody(
      fields({ email: ' clinician@example.com ', displayName: ' Test Clinician ', role: 'principal' }),
    );
    expect(body).toEqual({
      email: 'clinician@example.com',
      displayName: 'Test Clinician',
      role: 'principal',
    });
  });

  it('defaults to the sub role from the test fixture unchanged', () => {
    const body = buildCreateClinicianRequestBody(fields());
    expect(body.role).toBe('sub');
  });

  // 2026-08-31: the principal may set a colleague's first password. Absent
  // means "generate one" on the API side, so a blank field must not travel
  // as `password: ''` — that would be a chosen password Cognito rejects.
  it('omits password entirely when the field is blank', () => {
    const body = buildCreateClinicianRequestBody(fields({ password: '' }));
    expect(body).not.toHaveProperty('password');
  });

  it('sends a chosen password verbatim, without trimming it', () => {
    const body = buildCreateClinicianRequestBody(fields({ password: ' Sp ace-d 1 ' }));
    expect(body.password).toBe(' Sp ace-d 1 ');
  });
});
