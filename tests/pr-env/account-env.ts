// TASK 5.3.1: env plumbing for a11y-authenticated.test.ts, kept out of the
// spec file itself so the fail-loud-and-immediately shape below matches
// env.ts's own getBaseUrl() precedent (TASK 0.6.3) rather than each test
// discovering a missing variable separately, mid-run, as a confusing
// "fetch failed"/"selector not found".
//
// **This suite runs against production, never an ephemeral PR stack** — it
// needs a real, signed-in session and (for `call`) a real, live, in-window
// appointment, neither of which TASK 0.6.3's WebStack-only ephemeral copy
// has anything to authenticate against. `PRODUCTION_BASE_URL` is therefore
// a fixed constant, not an env var read from a just-created stack's own
// CloudFormation outputs the way `PR_ENV_BASE_URL` is.
export const PRODUCTION_BASE_URL = 'https://nourishthenerve.com';

export type AccountOwnerRole = 'patient' | 'clinician';

export interface ClinicianTestIdentity {
  readonly role: 'clinician';
  readonly email: string;
  readonly password: string;
  /** Base32 TOTP secret captured once at enrolment — see docs/runbooks/live-session-accessibility.md. */
  readonly totpSecret: string;
}

export interface PatientTestIdentity {
  readonly role: 'patient';
  readonly email: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set — a11y-authenticated.test.ts must run with every ` +
        'A11Y_CLINICIAN_* secret populated (see docs/runbooks/live-session-accessibility.md); ' +
        'it must never run as part of the ordinary unit/integration/pr-env suite.',
    );
  }
  return value;
}

// TASK 5.3.1's own Status section names why only this one identity is
// wired up: the clinician pool is password + TOTP (D-09/ADR-0004), both
// computable from stored secrets with no external mailbox — the patient
// pool is passwordless email OTP, which no test in this repository can
// complete without reading a real inbox, and SES production access
// remains denied (docs/runbooks/ses-production-access.md) regardless.
export function getClinicianTestIdentity(): ClinicianTestIdentity {
  return {
    role: 'clinician',
    email: requireEnv('A11Y_CLINICIAN_EMAIL'),
    password: requireEnv('A11Y_CLINICIAN_PASSWORD'),
    totpSecret: requireEnv('A11Y_CLINICIAN_TOTP_SECRET'),
  };
}

/**
 * Unset today — reading it returns `undefined` rather than throwing, so
 * every call site can name the patient-identity gap as "not yet wired"
 * instead of a hard failure. See getClinicianTestIdentity's own comment.
 */
export function getPatientTestIdentity(): PatientTestIdentity | undefined {
  const email = process.env.A11Y_PATIENT_EMAIL;
  return email ? { role: 'patient', email } : undefined;
}

/**
 * A live, in-window `<patientId>#<scheduledAt>` id (join-window.ts's own
 * key shape) for the `call` route's real content. Unset today — no
 * rolling fixture exists yet (see the runbook). `undefined` means the
 * spec scans `call` without a query string instead of skipping it
 * outright, which still exercises its real "too-early"/"join-denied"
 * states.
 */
export function getTestAppointmentId(): string | undefined {
  return process.env.A11Y_TEST_APPOINTMENT_ID;
}
