import { describe, expect, it } from 'vitest';

import { buildCreatePatientRequestBody } from './patient-admin-request.js';
import type { CreatePatientFormFields } from './patient-admin-request.js';

function fields(overrides: Partial<CreatePatientFormFields> = {}): CreatePatientFormFields {
  return {
    email: 'patient@example.com',
    fullName: 'Test Patient',
    phone: '',
    marketingOptIn: false,
    referralSource: '',
    presentingCondition: '',
    ...overrides,
  };
}

describe('buildCreatePatientRequestBody', () => {
  it('always includes email, fullName and marketingOptIn, trimmed', () => {
    const body = buildCreatePatientRequestBody(
      fields({ email: ' patient@example.com ', fullName: ' Test Patient ', marketingOptIn: true }),
    );
    expect(body).toEqual({
      email: 'patient@example.com',
      fullName: 'Test Patient',
      marketingOptIn: true,
    });
  });

  it('omits phone, referralSource and presentingCondition when left blank', () => {
    const body = buildCreatePatientRequestBody(fields());
    expect(body).not.toHaveProperty('phone');
    expect(body).not.toHaveProperty('referralSource');
    expect(body).not.toHaveProperty('presentingCondition');
  });

  it('omits a field that is only whitespace, the same as an empty one', () => {
    const body = buildCreatePatientRequestBody(fields({ phone: '   ' }));
    expect(body).not.toHaveProperty('phone');
  });

  it('includes and trims phone, referralSource and presentingCondition when given', () => {
    const body = buildCreatePatientRequestBody(
      fields({
        phone: ' +919812345670 ',
        referralSource: ' GP referral ',
        presentingCondition: ' Post-stroke rehabilitation ',
      }),
    );
    expect(body).toMatchObject({
      phone: '+919812345670',
      referralSource: 'GP referral',
      presentingCondition: 'Post-stroke rehabilitation',
    });
  });
});
