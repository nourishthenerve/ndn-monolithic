// D-30: pure request-shaping for `ClinicianAdminPanel.tsx`, the same
// reasoning `patient-admin-request.ts` states for its own existence — kept
// in its own file so a test importing it does not drag the component's
// untested JSX into coverage instrumentation.

/** What the create form collects. */
export interface CreateClinicianFormFields {
  readonly email: string;
  readonly displayName: string;
  readonly role: 'principal' | 'sub';
}

/** What `POST /clinicians` (clinician-admin.ts's own `createClinicianBodySchema`) actually accepts. */
export interface CreateClinicianRequestBody {
  readonly email: string;
  readonly displayName: string;
  readonly role: 'principal' | 'sub';
}

export function buildCreateClinicianRequestBody(
  fields: CreateClinicianFormFields,
): CreateClinicianRequestBody {
  return {
    email: fields.email.trim(),
    displayName: fields.displayName.trim(),
    role: fields.role,
  };
}
