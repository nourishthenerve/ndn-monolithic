// TASK 0.5.3 (R-01, R-02, NFR-09): step 3 of the SMS hard-cap mechanism —
// "+44-only destination allow-list with E.164 normalisation." SMS pumping
// fraud (R-02) targets premium and international ranges, so this is the
// first gate sendSms applies: reject anything that isn't a real UK mobile
// number before it can consume rate-limit or spend-cap budget.
export type E164 = string & { readonly __brand: 'UkMobileE164' };

// +44 followed by exactly 10 digits, the first of which is 7 (mobile
// range). The national trunk '0' is dropped in E.164 form, so a naive
// `startsWith('+44')` check would wrongly accept a spoof like
// "+4401234567890" (the national '0' pasted straight after +44) — this
// validates the full structure instead of a prefix.
const UK_MOBILE_E164 = /^\+447\d{9}$/;

export function normalizeUkE164(raw: string): E164 | undefined {
  const trimmed = raw.trim().replace(/[\s()-]/g, '');
  let candidate: string;
  if (trimmed.startsWith('+')) {
    candidate = trimmed;
  } else if (trimmed.startsWith('44')) {
    candidate = `+${trimmed}`;
  } else if (trimmed.startsWith('0')) {
    candidate = `+44${trimmed.slice(1)}`;
  } else {
    return undefined;
  }
  return UK_MOBILE_E164.test(candidate) ? (candidate as E164) : undefined;
}
