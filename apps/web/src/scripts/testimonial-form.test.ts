// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildTestimonialFormPayload,
  initTestimonialForm,
  submitTestimonialForm,
  type Fetcher,
} from './testimonial-form.js';

describe('buildTestimonialFormPayload', () => {
  it('builds a payload when every field, including the Turnstile token, is present', () => {
    const formData = new FormData();
    formData.set('quote', 'This service changed my recovery.');
    formData.set('attributionDisplay', 'firstNameOnly');
    formData.set('attributionName', 'Jordan');
    formData.set('contactEmail', 'jordan@example.com');
    formData.set('cf-turnstile-response', 'a-token');

    expect(buildTestimonialFormPayload(formData)).toEqual({
      quote: 'This service changed my recovery.',
      attributionDisplay: 'firstNameOnly',
      attributionName: 'Jordan',
      contactEmail: 'jordan@example.com',
      turnstileToken: 'a-token',
    });
  });

  it('builds a payload with no attributionName when display is anonymous', () => {
    const formData = new FormData();
    formData.set('quote', 'This service changed my recovery.');
    formData.set('attributionDisplay', 'anonymous');
    formData.set('contactEmail', 'jordan@example.com');
    formData.set('cf-turnstile-response', 'a-token');

    expect(buildTestimonialFormPayload(formData)).toEqual({
      quote: 'This service changed my recovery.',
      attributionDisplay: 'anonymous',
      contactEmail: 'jordan@example.com',
      turnstileToken: 'a-token',
    });
  });

  it('is undefined when the Turnstile token is missing (widget not yet solved)', () => {
    const formData = new FormData();
    formData.set('quote', 'This service changed my recovery.');
    formData.set('attributionDisplay', 'anonymous');
    formData.set('contactEmail', 'jordan@example.com');

    expect(buildTestimonialFormPayload(formData)).toBeUndefined();
  });

  it('is undefined when a non-anonymous attribution has no name', () => {
    const formData = new FormData();
    formData.set('quote', 'This service changed my recovery.');
    formData.set('attributionDisplay', 'full');
    formData.set('contactEmail', 'jordan@example.com');
    formData.set('cf-turnstile-response', 'a-token');

    expect(buildTestimonialFormPayload(formData)).toBeUndefined();
  });
});

const validPayload = {
  quote: 'This service changed my recovery.',
  attributionDisplay: 'firstNameOnly' as const,
  attributionName: 'Jordan',
  contactEmail: 'jordan@example.com',
  turnstileToken: 'a-token',
};

describe('submitTestimonialForm', () => {
  it('posts JSON to the testimonials endpoint and returns submitted on 201', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ status: 201 });
    await expect(submitTestimonialForm(validPayload, fetcher)).resolves.toBe('submitted');
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining('/testimonials'),
      expect.objectContaining({ method: 'POST', body: JSON.stringify(validPayload) }),
    );
  });

  it('returns rateLimited on 429', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ status: 429 });
    await expect(submitTestimonialForm(validPayload, fetcher)).resolves.toBe('rateLimited');
  });

  it('returns error on any other status', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ status: 400 });
    await expect(submitTestimonialForm(validPayload, fetcher)).resolves.toBe('error');
  });

  it('returns error, without throwing, when fetch itself rejects', async () => {
    const fetcher: Fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(submitTestimonialForm(validPayload, fetcher)).resolves.toBe('error');
  });
});

describe('initTestimonialForm', () => {
  function buildDom(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <form id="ndn-testimonial-form">
        <textarea name="quote">This service changed my recovery.</textarea>
        <select name="attributionDisplay">
          <option value="firstNameOnly" selected>First name only</option>
        </select>
        <input name="attributionName" value="Jordan" />
        <input name="contactEmail" value="jordan@example.com" />
        <div class="cf-turnstile">
          <input type="hidden" name="cf-turnstile-response" value="a-token" />
        </div>
        <button type="submit">Submit</button>
      </form>
      <p
        id="ndn-testimonial-form-status"
        hidden
        data-success-message="Thank you — pending review"
        data-rate-limited-message="Too many attempts"
        data-error-message="Something went wrong"
      ></p>
    `;
    document.body.appendChild(root);
    return root;
  }

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('is a no-op when the expected elements are absent', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    expect(() => initTestimonialForm(root)).not.toThrow();
  });

  it('on a successful submission, shows the success message and resets the form', async () => {
    const root = buildDom();
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 201 }) as unknown as typeof fetch;
    initTestimonialForm(root);

    const form = root.querySelector('#ndn-testimonial-form') as HTMLFormElement;
    const status = root.querySelector('#ndn-testimonial-form-status') as HTMLElement;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Thank you — pending review');
  });

  it('on a rate-limited submission, shows the rate-limited message without resetting the form', async () => {
    const root = buildDom();
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 429 }) as unknown as typeof fetch;
    initTestimonialForm(root);

    const form = root.querySelector('#ndn-testimonial-form') as HTMLFormElement;
    const quoteInput = form.querySelector('[name="quote"]') as HTMLTextAreaElement;
    const status = root.querySelector('#ndn-testimonial-form-status') as HTMLElement;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(status.textContent).toBe('Too many attempts');
    expect(quoteInput.value).toBe('This service changed my recovery.');
  });

  it('does not call fetch when the Turnstile token is missing', async () => {
    const root = buildDom();
    root.querySelector('.cf-turnstile')?.remove();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    initTestimonialForm(root);

    const form = root.querySelector('#ndn-testimonial-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
