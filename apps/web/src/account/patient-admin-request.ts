// D-29 (2026-08-29): pure request-shaping for `PatientAdminPanel.tsx`,
// deliberately in its own file with no React import. This directory has
// no jsdom/RTL rendering harness (`ClinicianCalendar.test.ts`'s own
// header names the convention: test the pure logic a component depends
// on, not the component's rendering) — kept separate from the component
// file itself so a test importing this file does not drag the
// component's own, much larger, untested JSX branches into coverage
// instrumentation. `ClinicianCalendar.tsx` colocates its own pure
// exports in the component file and pays exactly that coverage cost
// (`ClinicianCalendar.tsx` sits in the low double digits); every sibling
// component with no pure logic worth extracting (`CaseloadView.tsx`,
// `MessageThread.tsx`) instead has no test file at all and is invisible
// to coverage entirely. This file gets the same invisibility for the
// component it serves, without giving up a real, worthwhile unit test.

/** What the create form collects, before any trimming/omission. */
/** 2026-08-31: which programme the patient came in through — `Patient.tag`. */
export type PatientFormTag = 'IIC' | 'NDN';

export interface CreatePatientFormFields {
  readonly email: string;
  readonly fullName: string;
  readonly phone: string;
  readonly address: string;
  readonly tag: PatientFormTag;
  readonly marketingOptIn: boolean;
  readonly referralSource: string;
  readonly presentingCondition: string;
}

/** What `POST /patients` (patient-admin.ts's own `createPatientBodySchema`) actually accepts. */
export interface CreatePatientRequestBody {
  readonly email: string;
  readonly fullName: string;
  readonly phone?: string;
  readonly address?: string;
  /** Always sent — the form has no blank state for it, and defaults to `NDN`. */
  readonly tag: PatientFormTag;
  readonly marketingOptIn: boolean;
  readonly referralSource?: string;
  readonly presentingCondition?: string;
}

/**
 * A blank optional field must arrive as *absent*, not as an empty
 * string — `phone: ''` would pass the backend's own `z.string().optional()`
 * validation and get stored as a real, blank `personal.phone`, which is a
 * different fact than "no phone was given."
 */
export function buildCreatePatientRequestBody(
  fields: CreatePatientFormFields,
): CreatePatientRequestBody {
  const phone = fields.phone.trim();
  const address = fields.address.trim();
  const referralSource = fields.referralSource.trim();
  const presentingCondition = fields.presentingCondition.trim();
  return {
    email: fields.email.trim(),
    fullName: fields.fullName.trim(),
    marketingOptIn: fields.marketingOptIn,
    // Unlike every other field here, the tag is never omitted: it has no
    // "not given" state on the form (two radio-style choices, one always
    // selected), and an absent tag on the record means "created before
    // tagging existed", which a patient created today is not.
    tag: fields.tag,
    ...(phone ? { phone } : {}),
    ...(address ? { address } : {}),
    ...(referralSource ? { referralSource } : {}),
    ...(presentingCondition ? { presentingCondition } : {}),
  };
}
