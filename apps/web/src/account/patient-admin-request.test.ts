import { describe, expect, it } from 'vitest';

import { buildCreatePatientRequestBody } from './patient-admin-request.js';
import type { CreatePatientFormFields } from './patient-admin-request.js';

function fields(overrides: Partial<CreatePatientFormFields> = {}): CreatePatientFormFields {
  return {
    email: 'patient@example.com',
    fullName: 'Test Patient',
    phone: '',
    address: '',
    tag: 'NDN',
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
      // 2026-08-31: the tag joined the always-present set — see the tag
      // case below for why it has no "omitted" state.
      tag: 'NDN',
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

  // 2026-08-31: the tag is the one field with no "not given" state — it
  // always travels, because an absent tag on a record means "created
  // before tagging existed", which a patient created today is not.
  it('always sends a tag, even the default', () => {
    expect(buildCreatePatientRequestBody(fields()).tag).toBe('NDN');
    expect(buildCreatePatientRequestBody(fields({ tag: 'IIC' })).tag).toBe('IIC');
  });

  it('omits a blank address entirely, and trims one that is given', () => {
    expect(buildCreatePatientRequestBody(fields({ address: '   ' }))).not.toHaveProperty('address');
    expect(buildCreatePatientRequestBody(fields({ address: ' 1 Example Street ' })).address).toBe(
      '1 Example Street',
    );
  });
});
