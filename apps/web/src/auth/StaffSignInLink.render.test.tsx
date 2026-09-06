// @vitest-environment jsdom
//
// 2026-09-06: the footer's clinician-pool link. The property under test is
// the one the 2026-09-02 nav bug established — a signed-in visitor is never
// offered a route into the *other* Cognito pool, because that pool's own
// hosted-UI cookie may still be live and would re-authenticate silently.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { StaffSignInLink } from './StaffSignInLink.js';

afterEach(cleanup);

// Hoisted rather than written inline as `label="..."`: the `label`
// attribute is one the i18n lint rule treats as user-facing copy, and a
// string literal there is an error even in a test. Every other suite in
// apps/web passes its copy through an object for the same reason.
const LABEL = 'Clinician and staff sign in';

function clientResolving(state: unknown, delayForever = false) {
  return {
    resolve: () => (delayForever ? new Promise(() => {}) : Promise.resolve(state)),
    signOut: () => Promise.resolve(undefined),
  } as never;
}

describe('StaffSignInLink', () => {
  it('points a signed-out visitor at the clinician pool, not the patient one', async () => {
    render(<StaffSignInLink label={LABEL} client={clientResolving({ status: 'signed-out' })} />);
    const link = await screen.findByRole('link', { name: LABEL });
    expect(link.getAttribute('href')).toBe('/auth/signin?pool=clinician');
  });

  it('renders nothing for a signed-in visitor — the 2026-09-02 rule, applied to the other pool', async () => {
    const { container } = render(
      <StaffSignInLink
        label={LABEL}
        client={clientResolving({ status: 'signed-in', session: {} })}
      />,
    );
    // `findBy*` cannot assert an absence, and asserting "still empty" the
    // instant after render would pass even if the component *did* go on to
    // render the link. `act` flushes the effect and the promise it awaits,
    // so this is the settled state, not the initial one.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
  });

  it('renders nothing while the session is still resolving', () => {
    const { container } = render(
      <StaffSignInLink label={LABEL} client={clientResolving(undefined, true)} />,
    );
    expect(container.textContent).toBe('');
  });

  it('falls back to offering the link when the session cannot be resolved', async () => {
    const failing = {
      resolve: () => Promise.reject(new Error('network')),
      signOut: () => Promise.resolve(undefined),
    } as never;
    render(<StaffSignInLink label={LABEL} client={failing} />);
    // Same direction `SessionNav` chose: a clinician who cannot reach their
    // own pool cannot work at all, and the Lambda authorizer is the real
    // boundary regardless of what this renders.
    expect(await screen.findByRole('link', { name: LABEL })).toBeDefined();
  });
});
