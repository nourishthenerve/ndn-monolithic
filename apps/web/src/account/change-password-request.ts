// D-34 (2026-08-31): pure request-shaping/validation for
// `ChangePasswordPanel.tsx`, the same reasoning `patient-admin-request.ts`
// states for its own existence — kept in its own file so a test importing
// it does not drag the component's untested JSX into coverage
// instrumentation.
//
// The "do the two new-password fields match" check happens here, client
// side, before a request is ever sent — not because the server would
// accept a mismatch (it never sees `confirmPassword` at all, only
// `newPassword`), but because failing that obviously-local check with a
// round trip would be a worse experience for no real benefit.

export interface ChangePasswordFormFields {
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly confirmPassword: string;
}

export interface ChangePasswordRequestBody {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export type ChangePasswordValidation =
  | { readonly valid: true; readonly body: ChangePasswordRequestBody }
  | { readonly valid: false; readonly reason: 'empty' | 'mismatch' };

export function validateChangePasswordFields(
  fields: ChangePasswordFormFields,
): ChangePasswordValidation {
  if (!fields.currentPassword || !fields.newPassword || !fields.confirmPassword) {
    return { valid: false, reason: 'empty' };
  }
  if (fields.newPassword !== fields.confirmPassword) {
    return { valid: false, reason: 'mismatch' };
  }
  return {
    valid: true,
    body: { currentPassword: fields.currentPassword, newPassword: fields.newPassword },
  };
}
