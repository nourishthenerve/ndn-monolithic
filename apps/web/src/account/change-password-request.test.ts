import { describe, expect, it } from 'vitest';

import { validateChangePasswordFields } from './change-password-request.js';
import type { ChangePasswordFormFields } from './change-password-request.js';

function fields(overrides: Partial<ChangePasswordFormFields> = {}): ChangePasswordFormFields {
  return {
    currentPassword: 'OldPassw0rd!',
    newPassword: 'NewPassw0rd!',
    confirmPassword: 'NewPassw0rd!',
    ...overrides,
  };
}

describe('validateChangePasswordFields', () => {
  it('accepts matching new/confirm passwords and shapes the request body', () => {
    const result = validateChangePasswordFields(fields());
    expect(result).toEqual({
      valid: true,
      body: { currentPassword: 'OldPassw0rd!', newPassword: 'NewPassw0rd!' },
    });
  });

  it('rejects a new/confirm mismatch without ever including confirmPassword in the body', () => {
    const result = validateChangePasswordFields(fields({ confirmPassword: 'Different1!' }));
    expect(result).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rejects any blank field', () => {
    expect(validateChangePasswordFields(fields({ currentPassword: '' }))).toEqual({
      valid: false,
      reason: 'empty',
    });
    expect(validateChangePasswordFields(fields({ newPassword: '' }))).toEqual({
      valid: false,
      reason: 'empty',
    });
    expect(validateChangePasswordFields(fields({ confirmPassword: '' }))).toEqual({
      valid: false,
      reason: 'empty',
    });
  });
});
