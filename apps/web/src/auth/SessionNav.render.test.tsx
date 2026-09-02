// @vitest-environment jsdom
//
// 2026-09-02. The bug this component exists for is not a permission
// failure — it is a *control that should not have been on the page*, so
// the test has to be about what is rendered, not about what an API
// returns. The owner, signed in as the principal clinician, clicked
// "Patient sign in" in the nav and landed on a test patient's details.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionNav } from './SessionNav.js';
import type { SessionNavStrings } from './SessionNav.js';

afterEach(cleanup);

const STRINGS: SessionNavStrings = {
  patientSignIn: 'Patient sign in',
  clinicianSignIn: 'Clinician sign in',
  account: 'Your account',
  signOut: 'Sign out',
};

function clientResolving(state: unknown, delayForever = false) {
  return {
    resolve: () => (delayForever ? new Promise(() => {}) : Promise.resolve(state)),
    signOut: () => Promise.resolve(undefined),
  } as never;
}

describe('signed in', () => {
  const signedIn = clientResolving({ status: 'signed-in', session: {} });

  it('offers neither sign-in link — the bug this exists to stop', async () => {
    render(<SessionNav strings={STRINGS} accountHref="/en/account" client={signedIn} />);
    await screen.findByRole('button', { name: 'Sign out' });
    expect(screen.queryByText('Patient sign in')).toBeNull();
    expect(screen.queryByText('Clinician sign in')).toBeNull();
  });

  it('offers sign out and a way to the account instead', async () => {
    render(<SessionNav strings={STRINGS} accountHref="/en/account" client={signedIn} />);
    expect(await screen.findByRole('button', { name: 'Sign out' })).toBeDefined();
    expect(screen.getByRole('link', { name: 'Your account' }).getAttribute('href')).toBe(
      '/en/account',
    );
  });
});

describe('signed out', () => {
  const signedOut = clientResolving({ status: 'signed-out' });

  it('offers both pools, pointed at their own sign-in routes', async () => {
    render(<SessionNav strings={STRINGS} accountHref="/en/account" client={signedOut} />);
    const patient = await screen.findByRole('link', { name: 'Patient sign in' });
    expect(patient.getAttribute('href')).toBe('/auth/signin');
    expect(
      screen.getByRole('link', { name: 'Clinician sign in' }).getAttribute('href'),
    ).toBe('/auth/signin?pool=clinician');
  });

  it('offers no sign-out button', async () => {
    render(<SessionNav strings={STRINGS} accountHref="/en/account" client={signedOut} />);
    await screen.findByRole('link', { name: 'Patient sign in' });
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });
});

describe('while the session is still resolving', () => {
  it('renders nothing at all — a sign-in link shown for even a moment is one that can be clicked', () => {
    const { container } = render(
      <SessionNav
        strings={STRINGS}
        accountHref="/en/account"
        client={clientResolving(undefined, true)}
      />,
    );
    // Not a placeholder, not the signed-out links: either would be wrong
    // for half the visitors who saw it, and the wrong half is the one
    // holding a clinician session.
    expect(container.textContent).toBe('');
  });
});

describe('when the session cannot be resolved', () => {
  it('falls back to the signed-out controls rather than stranding the visitor', async () => {
    const failing = {
      resolve: () => Promise.reject(new Error('network')),
      signOut: () => Promise.resolve(undefined),
    } as never;
    render(<SessionNav strings={STRINGS} accountHref="/en/account" client={failing} />);
    // Offering sign-in to someone already signed in is recoverable;
    // hiding sign-out from someone who needs it is not.
    expect(await screen.findByRole('link', { name: 'Patient sign in' })).toBeDefined();
  });
});

describe('signing out', () => {
  it('goes through the session client, so Cognito\'s own cookie is cleared too', async () => {
    const signOut = vi.fn(() => Promise.resolve(undefined));
    const client = {
      resolve: () => Promise.resolve({ status: 'signed-in', session: {} }),
      signOut,
    } as never;
    render(<SessionNav strings={STRINGS} accountHref="/en/account" client={client} />);
    (await screen.findByRole('button', { name: 'Sign out' })).click();
    // Not a link to `/`: that would leave Cognito's hosted-UI session live
    // and the next sign-in would re-authenticate silently against it —
    // the 2026-08-31 finding in session.ts's own doc.
    await waitFor(() => {
      expect(signOut).toHaveBeenCalled();
    });
  });
});
