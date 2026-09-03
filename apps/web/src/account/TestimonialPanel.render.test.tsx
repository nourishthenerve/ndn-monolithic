// @vitest-environment jsdom
// 2026-09-03: what the panel says when it cannot show a testimonial.
//
// Written after a live report — *"when I login as a patient and go to your
// testimonial button it says … Your testimonial could not be loaded.
// Please try again."* The API was answering `404`, because the
// `testimonials.enabled` flag had never been created under its new name
// after the 2026-09-02 rename and the flag reader fails closed.
//
// The bug was the flag. What this file is about is the *sentence*: "could
// not be loaded, please try again" gave advice that could not work, about
// a cause it did not name, and made a one-line SSM fix take a round trip
// to diagnose. A disabled feature and a failed request are different
// facts and now read differently.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SessionClient } from '../auth/session.js';

import { TestimonialPanel } from './TestimonialPanel.js';

afterEach(cleanup);

const STRINGS = {
  heading: 'Your testimonial',
  intro: 'You can publish one testimonial about your care.',
  loading: 'Loading your testimonial…',
  forbidden: 'Only patients can write a testimonial.',
  unavailable: 'Testimonials are not switched on yet. Please check back later.',
  error: 'Your testimonial could not be loaded. Please try again.',
  quoteLabel: 'What would you like to say?',
  displayLabel: 'How should we credit you?',
  displayFull: 'My full name',
  displayFirstNameOnly: 'My first name only',
  displayAnonymous: 'Anonymously',
  nameLabel: 'Name',
  nameRequired: 'Please give a name or choose to stay anonymous.',
  consentNotice: 'Saving this publishes it.',
  publishButton: 'Publish my testimonial',
  updateButton: 'Update my testimonial',
  saving: 'Saving…',
  savedMessage: 'Saved.',
  withdrawButton: 'Withdraw my testimonial',
  withdrawnMessage: 'Withdrawn.',
  withdrawnNotice: 'This testimonial is withdrawn.',
  saveFailed: 'Could not be saved.',
};

const signedIn: SessionClient = {
  authorization: () => Promise.resolve('token-1'),
} as unknown as SessionClient;

function respond(status: number, body: unknown = {}): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response);
}

function renderPanel(fetchMine: () => Promise<Response>) {
  return render(
    <TestimonialPanel strings={STRINGS} client={signedIn} fetchMine={fetchMine} locale="en" />,
  );
}

describe('TestimonialPanel — why there is no form', () => {
  it('says the feature is off on a 404, not that something went wrong', async () => {
    // The live case. `testimonials.enabled` unset → the handler 404s → the
    // patient used to be told to try again, which could never help.
    renderPanel(() => respond(404, { error: 'NOT_FOUND' }));

    expect(await screen.findByText(STRINGS.unavailable)).toBeTruthy();
    expect(screen.queryByText(STRINGS.error)).toBeNull();
  });

  it('does not dress a disabled feature as an error', async () => {
    // `role="status"`, not `alert` — nothing has gone wrong.
    renderPanel(() => respond(404));

    const message = await screen.findByText(STRINGS.unavailable);
    expect(message.getAttribute('role')).toBe('status');
  });

  it.each([401, 403])('says who may write one on a %s', async (status) => {
    renderPanel(() => respond(status));

    expect(await screen.findByText(STRINGS.forbidden)).toBeTruthy();
  });

  it.each([500, 502])('keeps "try again" for a %s, where trying again might work', async (status) => {
    renderPanel(() => respond(status));

    expect(await screen.findByText(STRINGS.error)).toBeTruthy();
  });

  it('treats a thrown request as an error too', async () => {
    renderPanel(() => Promise.reject(new Error('offline')));

    expect(await screen.findByText(STRINGS.error)).toBeTruthy();
  });
});

describe('TestimonialPanel — the form', () => {
  it('offers an empty form when the patient has not written one', async () => {
    renderPanel(() => respond(200, { item: null }));

    expect(await screen.findByRole('button', { name: STRINGS.publishButton })).toBeTruthy();
    expect((screen.getByLabelText(STRINGS.quoteLabel) as HTMLTextAreaElement).value).toBe('');
    // Nothing to withdraw yet.
    expect(screen.queryByRole('button', { name: STRINGS.withdrawButton })).toBeNull();
  });

  it('loads an existing testimonial and offers to update or withdraw it', async () => {
    renderPanel(() =>
      respond(200, {
        item: {
          quote: { en: 'The team got me walking again.' },
          attribution: { display: 'firstNameOnly', name: 'Jordan' },
          status: 'published',
        },
      }),
    );

    expect(await screen.findByRole('button', { name: STRINGS.updateButton })).toBeTruthy();
    expect((screen.getByLabelText(STRINGS.quoteLabel) as HTMLTextAreaElement).value).toBe(
      'The team got me walking again.',
    );
    expect(screen.getByRole('button', { name: STRINGS.withdrawButton })).toBeTruthy();
  });

  it('keeps the text of a withdrawn one, and offers to publish it again', async () => {
    renderPanel(() =>
      respond(200, {
        item: {
          quote: { en: 'Still true.' },
          attribution: { display: 'anonymous' },
          status: 'withdrawn',
        },
      }),
    );

    expect(await screen.findByText(STRINGS.withdrawnNotice)).toBeTruthy();
    expect((screen.getByLabelText(STRINGS.quoteLabel) as HTMLTextAreaElement).value).toBe(
      'Still true.',
    );
    // Publish, not update — and nothing to withdraw, since it already is.
    expect(screen.getByRole('button', { name: STRINGS.publishButton })).toBeTruthy();
    expect(screen.queryByRole('button', { name: STRINGS.withdrawButton })).toBeNull();
  });

  it('hides the name field when the patient chooses anonymity', async () => {
    renderPanel(() =>
      respond(200, {
        item: { quote: { en: 'x' }, attribution: { display: 'anonymous' }, status: 'published' },
      }),
    );

    await screen.findByRole('button', { name: STRINGS.updateButton });
    expect(screen.queryByLabelText(STRINGS.nameLabel)).toBeNull();
  });

  it('says so when there is no session at all', async () => {
    const fetchMine = vi.fn();
    render(
      <TestimonialPanel
        strings={STRINGS}
        client={{ authorization: () => Promise.resolve(undefined) } as unknown as SessionClient}
        fetchMine={fetchMine}
        locale="en"
      />,
    );

    expect(await screen.findByText(STRINGS.forbidden)).toBeTruthy();
    expect(fetchMine).not.toHaveBeenCalled();
  });
});
