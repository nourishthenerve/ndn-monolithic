// TASK 1.4.1: the contact page's only browser-side script — ADR-0017 means
// there is no server, so submission is a runtime `fetch` to the same-origin
// `/contact` route (infra/src/web-stack.ts proxies it through CloudFront,
// so this is same-origin, no CORS involved). All user-facing copy is read
// from the status element's own `data-*` attributes (set via `t()` in
// contact.astro), never hardcoded here — same convention consent.ts/
// CookieBanner.tsx use for their own strings, and required by the
// apps/web-scoped `no-hardcoded-strings` lint rule.
export interface ContactFormPayload {
  readonly name: string;
  readonly email: string;
  readonly message: string;
  readonly turnstileToken: string;
}

/**
 * `undefined` if any field is missing or empty. The form's own `required`
 * attributes are the first line of defence (and Turnstile itself won't
 * populate its hidden input until solved); this is a defensive check
 * before a network call is made at all.
 */
export function buildContactFormPayload(formData: FormData): ContactFormPayload | undefined {
  const name = formData.get('name');
  const email = formData.get('email');
  const message = formData.get('message');
  const turnstileToken = formData.get('cf-turnstile-response');

  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    typeof email !== 'string' ||
    email.length === 0 ||
    typeof message !== 'string' ||
    message.length === 0 ||
    typeof turnstileToken !== 'string' ||
    turnstileToken.length === 0
  ) {
    return undefined;
  }

  return { name, email, message, turnstileToken };
}

export type ContactFormSubmitOutcome = 'sent' | 'rateLimited' | 'error';

export type Fetcher = typeof fetch;

/** Never throws — a network failure is reported the same way as a 4xx/5xx: 'error'. */
export async function submitContactForm(
  payload: ContactFormPayload,
  fetcher: Fetcher = fetch,
): Promise<ContactFormSubmitOutcome> {
  try {
    const response = await fetcher('/contact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.status === 200) return 'sent';
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

const OUTCOME_MESSAGE_DATASET_KEY: Record<ContactFormSubmitOutcome, string> = {
  sent: 'successMessage',
  rateLimited: 'rateLimitedMessage',
  error: 'errorMessage',
};

/** Wires the form's submit handler. A no-op if the expected elements aren't present. */
export function initContactForm(root: ParentNode = document): void {
  const form = root.querySelector<HTMLFormElement>('#ndn-contact-form');
  const status = root.querySelector<HTMLElement>('#ndn-contact-form-status');
  if (!form || !status) {
    return;
  }
  const widget = root.querySelector<HTMLElement>('.cf-turnstile');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const payload = buildContactFormPayload(new FormData(form));
    if (!payload) {
      return;
    }

    void submitContactForm(payload).then((outcome) => {
      status.textContent = status.dataset[OUTCOME_MESSAGE_DATASET_KEY[outcome]] ?? '';
      status.hidden = false;

      if (outcome === 'sent') {
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
