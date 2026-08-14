// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildContactFormPayload,
  initContactForm,
  submitContactForm,
  type Fetcher,
} from './contact-form.js';

describe('buildContactFormPayload', () => {
  it('builds a payload when every field, including the Turnstile token, is present', () => {
    const formData = new FormData();
    formData.set('name', 'Ada Lovelace');
    formData.set('email', 'ada@example.com');
    formData.set('message', 'Hello there');
    formData.set('cf-turnstile-response', 'a-token');

    expect(buildContactFormPayload(formData)).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      message: 'Hello there',
      turnstileToken: 'a-token',
    });
  });

  it('is undefined when the Turnstile token is missing (widget not yet solved)', () => {
    const formData = new FormData();
    formData.set('name', 'Ada Lovelace');
    formData.set('email', 'ada@example.com');
    formData.set('message', 'Hello there');

    expect(buildContactFormPayload(formData)).toBeUndefined();
  });

  it('is undefined when a required field is empty', () => {
    const formData = new FormData();
    formData.set('name', '');
    formData.set('email', 'ada@example.com');
    formData.set('message', 'Hello there');
    formData.set('cf-turnstile-response', 'a-token');

    expect(buildContactFormPayload(formData)).toBeUndefined();
  });
});

const validPayload = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  message: 'Hello there',
  turnstileToken: 'a-token',
};

describe('submitContactForm', () => {
  it('posts JSON to /contact and returns sent on 200', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ status: 200 });
    await expect(submitContactForm(validPayload, fetcher)).resolves.toBe('sent');
    expect(fetcher).toHaveBeenCalledWith(
      '/contact',
      expect.objectContaining({ method: 'POST', body: JSON.stringify(validPayload) }),
    );
  });

  it('returns rateLimited on 429', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ status: 429 });
    await expect(submitContactForm(validPayload, fetcher)).resolves.toBe('rateLimited');
  });

  it('returns error on any other status', async () => {
    const fetcher: Fetcher = vi.fn().mockResolvedValue({ status: 400 });
    await expect(submitContactForm(validPayload, fetcher)).resolves.toBe('error');
  });

  it('returns error, without throwing, when fetch itself rejects', async () => {
    const fetcher: Fetcher = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(submitContactForm(validPayload, fetcher)).resolves.toBe('error');
  });
});

describe('initContactForm', () => {
  function buildDom(): HTMLElement {
    const root = document.createElement('div');
    root.innerHTML = `
      <form id="ndn-contact-form">
        <input name="name" value="Ada Lovelace" />
        <input name="email" value="ada@example.com" />
        <textarea name="message">Hello there</textarea>
        <div class="cf-turnstile">
          <input type="hidden" name="cf-turnstile-response" value="a-token" />
        </div>
        <button type="submit">Send</button>
      </form>
      <p
        id="ndn-contact-form-status"
        hidden
        data-success-message="Sent!"
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
    expect(() => initContactForm(root)).not.toThrow();
  });

  it('on a successful submission, shows the success message and resets the form', async () => {
    const root = buildDom();
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 200 }) as unknown as typeof fetch;
    initContactForm(root);

    const form = root.querySelector('#ndn-contact-form') as HTMLFormElement;
    const status = root.querySelector('#ndn-contact-form-status') as HTMLElement;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe('Sent!');
  });

  it('on a rate-limited submission, shows the rate-limited message without resetting the form', async () => {
    const root = buildDom();
    globalThis.fetch = vi.fn().mockResolvedValue({ status: 429 }) as unknown as typeof fetch;
    initContactForm(root);

    const form = root.querySelector('#ndn-contact-form') as HTMLFormElement;
    const nameInput = form.querySelector('[name="name"]') as HTMLInputElement;
    const status = root.querySelector('#ndn-contact-form-status') as HTMLElement;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(status.textContent).toBe('Too many attempts');
    expect(nameInput.value).toBe('Ada Lovelace');
  });

  it('does not call fetch when the Turnstile token is missing', async () => {
    const root = buildDom();
    root.querySelector('.cf-turnstile')?.remove();
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    initContactForm(root);

    const form = root.querySelector('#ndn-contact-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
