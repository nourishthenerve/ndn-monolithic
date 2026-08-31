// D-30: pure request-shaping for `ClinicianAdminPanel.tsx`, the same
// reasoning `patient-admin-request.ts` states for its own existence — kept
// in its own file so a test importing it does not drag the component's
// untested JSX into coverage instrumentation.

/** What the create form collects. */
export interface CreateClinicianFormFields {
  readonly email: string;
  readonly displayName: string;
  readonly role: 'principal' | 'sub';
  /** Blank means "generate one" — see `buildCreateClinicianRequestBody`. */
  readonly password: string;
}

/** What `POST /clinicians` (clinician-admin.ts's own `createClinicianBodySchema`) actually accepts. */
export interface CreateClinicianRequestBody {
  readonly email: string;
  readonly displayName: string;
  readonly role: 'principal' | 'sub';
  readonly password?: string;
}

/**
 * A blank password field must arrive as *absent*, not as an empty string —
 * the same rule `patient-admin-request.ts` states for its own optional
 * fields, and here it decides real behaviour rather than a stored value:
 * absent means the API generates one (D-30's default, and still the
 * stronger choice), whereas `''` would be a password the principal
 * "chose", rejected by Cognito's policy for reasons the form would then
 * have to explain.
 *
 * The password is deliberately **not** trimmed. Leading or trailing
 * whitespace is a legitimate part of a password, and silently removing it
 * here would set a credential that differs from the one the principal is
 * about to read out over WhatsApp.
 */
export function buildCreateClinicianRequestBody(
  fields: CreateClinicianFormFields,
): CreateClinicianRequestBody {
  return {
    email: fields.email.trim(),
    displayName: fields.displayName.trim(),
    role: fields.role,
    ...(fields.password ? { password: fields.password } : {}),
  };
}
