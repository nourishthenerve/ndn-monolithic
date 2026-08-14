// TASK 1.4.2: the testimonials page's submission script — ADR-0017 means
// there is no server, so submission is a runtime `fetch` straight to
// infra/src/data-stack.ts's ContentHttpApi (`contentApiUrl`), not a
// same-origin CloudFront-proxied route like scripts/contact-form.ts's
// `/contact` — no runtime table access exists in web-stack.ts (see
// data-stack.ts's own TASK 1.4.2 comment for why), so this is a genuine
// cross-origin call and relies on that API's CORS config. All user-facing
// copy is read from the status element's own `data-*` attributes (set via
// `t()` in the page), never hardcoded here — same convention
// scripts/contact-form.ts follows, required by the apps/web-scoped
// `no-hardcoded-strings` lint rule.
import { contentApiUrl } from '../site-config.js';

export interface TestimonialFormPayload {
  readonly quote: string;
  readonly attributionDisplay: 'full' | 'firstNameOnly' | 'anonymous';
  readonly attributionName?: string;
  readonly contactEmail: string;
  readonly turnstileToken: string;
}

const ATTRIBUTION_DISPLAYS = new Set(['full', 'firstNameOnly', 'anonymous']);

/**
 * `undefined` if a required field is missing/empty, or a non-anonymous
 * attribution has no name — same defensive-before-any-network-call check
 * `buildContactFormPayload` (scripts/contact-form.ts) performs.
 */
export function buildTestimonialFormPayload(
  formData: FormData,
): TestimonialFormPayload | undefined {
  const quote = formData.get('quote');
  const attributionDisplay = formData.get('attributionDisplay');
  const attributionNameRaw = formData.get('attributionName');
  const contactEmail = formData.get('contactEmail');
  const turnstileToken = formData.get('cf-turnstile-response');

  if (
    typeof quote !== 'string' ||
    quote.length === 0 ||
    typeof attributionDisplay !== 'string' ||
    !ATTRIBUTION_DISPLAYS.has(attributionDisplay) ||
    typeof contactEmail !== 'string' ||
    contactEmail.length === 0 ||
    typeof turnstileToken !== 'string' ||
    turnstileToken.length === 0
  ) {
    return undefined;
  }

  const attributionName = typeof attributionNameRaw === 'string' ? attributionNameRaw : '';
  if (attributionDisplay !== 'anonymous' && attributionName.length === 0) {
    return undefined;
  }

  return {
    quote,
    attributionDisplay: attributionDisplay as TestimonialFormPayload['attributionDisplay'],
    ...(attributionName.length > 0 ? { attributionName } : {}),
    contactEmail,
    turnstileToken,
  };
}

export type TestimonialFormSubmitOutcome = 'submitted' | 'rateLimited' | 'error';

export type Fetcher = typeof fetch;

/** Never throws — a network failure is reported the same way as a 4xx/5xx: 'error'. */
export async function submitTestimonialForm(
  payload: TestimonialFormPayload,
  fetcher: Fetcher = fetch,
): Promise<TestimonialFormSubmitOutcome> {
  try {
    const response = await fetcher(`${contentApiUrl}/testimonials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 201) return 'submitted';
    if (response.status === 429) return 'rateLimited';
    return 'error';
  } catch {
    return 'error';
  }
}

declare global {
  interface Window {
    turnstile?: { reset: (container?: string | HTMLElement) => void };
  }
}

const OUTCOME_MESSAGE_DATASET_KEY: Record<TestimonialFormSubmitOutcome, string> = {
  submitted: 'successMessage',
  rateLimited: 'rateLimitedMessage',
  error: 'errorMessage',
};

/** Wires the form's submit handler. A no-op if the expected elements aren't present. */
export function initTestimonialForm(root: ParentNode = document): void {
  const form = root.querySelector<HTMLFormElement>('#ndn-testimonial-form');
  const status = root.querySelector<HTMLElement>('#ndn-testimonial-form-status');
  if (!form || !status) {
    return;
  }
  const widget = root.querySelector<HTMLElement>('.cf-turnstile');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = buildTestimonialFormPayload(new FormData(form));
    if (!payload) {
      return;
    }

    void submitTestimonialForm(payload).then((outcome) => {
      status.textContent = status.dataset[OUTCOME_MESSAGE_DATASET_KEY[outcome]] ?? '';
      status.hidden = false;

      if (outcome === 'submitted') {
        form.reset();
      }
      // A rejected or expired token can't be reused — every outcome resets
      // the widget so the visitor always gets a fresh challenge to retry.
      if (widget) {
        window.turnstile?.reset(widget);
      }
    });
  });
}
