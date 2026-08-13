// TASK 1.2.3: the single typed gate FR-WEB-07 requires — any future
// non-essential script (analytics, a third-party embed) must call
// hasConsent() before it runs or sets its own cookie, rather than growing
// its own ad-hoc "has the user agreed" check. CookieConsentBanner.tsx is
// the only current writer (via setConsent); everything else only reads.
const CONSENT_COOKIE_NAME = 'ndn_consent';
const CONSENT_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export type ConsentCategory = 'essential' | 'analytics';

const consentCategories: readonly ConsentCategory[] = ['essential', 'analytics'];

function isConsentCategory(value: string): value is ConsentCategory {
  return (consentCategories as readonly string[]).includes(value);
}

function readStoredCategories(): ConsentCategory[] | undefined {
  const match = /(?:^|;\s*)ndn_consent=([^;]*)/.exec(document.cookie);
  if (!match || match[1] === undefined) {
    return undefined;
  }
  return decodeURIComponent(match[1]).split(',').filter(isConsentCategory);
}

/** 'essential' is always true — every other category requires a recorded, explicit opt-in. */
export function hasConsent(category: ConsentCategory): boolean {
  if (category === 'essential') {
    return true;
  }
  return (readStoredCategories() ?? []).includes(category);
}

/** Whether a decision (accept or reject) has been recorded at all — CookieConsentBanner's own show/hide check. */
export function hasStoredConsent(): boolean {
  return readStoredCategories() !== undefined;
}

/**
 * Records the visitor's choice as a first-party cookie. `essential` is
 * always included regardless of `categories` — it can't be rejected. Never
 * sets any other cookie itself.
 */
export function setConsent(categories: ConsentCategory[]): void {
  const unique = Array.from(new Set<ConsentCategory>(['essential', ...categories]));
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie =
    `${CONSENT_COOKIE_NAME}=${encodeURIComponent(unique.join(','))}; path=/; ` +
    `max-age=${CONSENT_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}
