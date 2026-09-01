// @vitest-environment jsdom
//
// 2026-09-01: the rendered half of the dashboard feed — see
// `AssessmentForm.render.test.tsx`'s header for why `apps/web` grew an
// RTL dependency. `PatientNotifications.test.ts` pins the two pure
// helpers; this pins the states a patient actually lands on.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PatientNotifications } from './PatientNotifications.js';
import type { PatientNotificationsStrings } from './PatientNotifications.js';

afterEach(cleanup);

const STRINGS: PatientNotificationsStrings = {
  heading: 'Updates',
  loadingLabel: 'Loading your updates…',
  forbiddenLabel: 'You do not have access to this.',
  errorLabel: 'Something went wrong loading your updates.',
  emptyLabel: 'You have no new updates.',
  dismissLabel: 'Dismiss',
  forLabel: 'for',
  genericLabel: 'Something changed about your appointments.',
  kindLabels: {
    'appointment-requested': 'Your clinician has requested an appointment.',
    'appointment-approved': 'Your appointment is confirmed.',
    'appointment-cancelled': 'An appointment has been cancelled.',
    'calendar-updated': 'Your clinician has updated your calendar.',
  },
};

/**
 * Opaque on purpose, and deliberately not JWT-shaped.
 *
 * This component never decodes the token — unlike `AssessmentForm`, which
 * reads the viewer's pool from it, it only forwards the value as an
 * `Authorization` header — so a fixture that *looked* like a JWT was
 * claiming a structure nothing here depends on.
 *
 * It also tripped the CI secret scan: a base64 segment of that length
 * assigned to a constant called `TOKEN` is exactly the shape
 * `gitleaks`'s `generic-api-key` rule exists to catch, and it was right to
 * flag it — the string was invented, but nothing about it said so. A test
 * fixture that reads as a credential is a bad fixture even when it is not
 * one, because every future reader has to work out which it is.
 */
const TOKEN = 'test-access-token';
const client = { authorization: () => Promise.resolve(TOKEN) } as never;

function notice(overrides: Record<string, unknown> = {}) {
  return {
    notificationId: '2026-09-01T09:00:00.000Z#a',
    kind: 'appointment-approved',
    subjectAt: '2026-09-05T10:00:00.000Z',
    created_at: '2026-09-01T09:00:00.000Z',
    read: false,
    ...overrides,
  };
}

function ok(body: unknown): Promise<Response> {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response);
}

describe('the dashboard feed', () => {
  it('renders the wording for each kind, and the time it is about', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        fetchNotifications={() =>
          ok({
            items: [
              notice({ notificationId: 'a', kind: 'appointment-approved' }),
              notice({ notificationId: 'b', kind: 'calendar-updated', subjectAt: undefined }),
            ],
          })
        }
      />,
    );

    expect(await screen.findByText(/Your appointment is confirmed/)).toBeDefined();
    expect(screen.getByText(/Your clinician has updated your calendar/)).toBeDefined();
    // The instant the notice is *about* travels machine-readably; the text
    // renders in the reader's own timezone.
    const time = document.querySelector('time');
    expect(time?.getAttribute('datetime')).toBe('2026-09-05T10:00:00.000Z');
  });

  it('says so when there is nothing new', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        fetchNotifications={() => ok({ items: [] })}
      />,
    );
    expect(await screen.findByText(STRINGS.emptyLabel)).toBeDefined();
  });

  it('lists only what is still unread', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        fetchNotifications={() =>
          ok({
            items: [
              notice({ notificationId: 'a', read: true, kind: 'appointment-cancelled' }),
              notice({ notificationId: 'b', read: false, kind: 'appointment-requested' }),
            ],
          })
        }
      />,
    );
    expect(await screen.findByText(/requested an appointment/)).toBeDefined();
    expect(screen.queryByText(/has been cancelled/)).toBeNull();
  });

  it('dismisses in place — one call, and the notice leaves the list', async () => {
    const markRead = vi.fn(() => ok({ item: notice({ read: true }) }));
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        markRead={markRead}
        fetchNotifications={() => ok({ items: [notice({ notificationId: 'a' })] })}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.getByText(STRINGS.emptyLabel)).toBeDefined();
    });
    expect(markRead).toHaveBeenCalledWith(TOKEN, 'a');
  });

  it('leaves the notice in place when dismissing fails — a state the person can act on again', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        markRead={() => Promise.resolve({ ok: false, status: 500 } as Response)}
        fetchNotifications={() => ok({ items: [notice()] })}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeDefined();
    });
  });

  it('renders a kind this build has never heard of as the generic line', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        fetchNotifications={() => ok({ items: [notice({ kind: 'appointment-rescheduled' })] })}
      />,
    );
    expect(await screen.findByText(new RegExp(STRINGS.genericLabel))).toBeDefined();
  });

  it('treats a 403 as an ordinary outcome, not an error — a clinician gets one here', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        fetchNotifications={() => Promise.resolve({ ok: false, status: 403 } as Response)}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });

  it('shows the error state when the request itself fails', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={client}
        fetchNotifications={() => Promise.reject(new Error('network'))}
      />,
    );
    expect(await screen.findByText(STRINGS.errorLabel)).toBeDefined();
  });

  it('is forbidden when there is no session at all', async () => {
    render(
      <PatientNotifications
        strings={STRINGS}
        client={{ authorization: () => Promise.resolve(undefined) } as never}
      />,
    );
    expect(await screen.findByText(STRINGS.forbiddenLabel)).toBeDefined();
  });
});
