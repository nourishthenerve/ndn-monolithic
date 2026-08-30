import { describe, expect, it } from 'vitest';

import { buildCreateClinicianRequestBody } from './clinician-admin-request.js';
import type { CreateClinicianFormFields } from './clinician-admin-request.js';

function fields(overrides: Partial<CreateClinicianFormFields> = {}): CreateClinicianFormFields {
  return {
    email: 'clinician@example.com',
    displayName: 'Test Clinician',
    role: 'sub',
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
});
