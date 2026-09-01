// 2026-09-01. Same posture as its siblings in this directory: the pure
// functions are tested directly rather than the rendered component (no
// jsdom/RTL pattern here — join-window.test.ts's own precedent).
import { describe, expect, it } from 'vitest';

import { notificationLabel, unreadOf } from './PatientNotifications.js';
import type { PatientNotificationItem } from './PatientNotifications.js';

function notice(overrides: Partial<PatientNotificationItem> = {}): PatientNotificationItem {
  return {
    notificationId: '2026-09-01T09:00:00.000Z#abc',
    kind: 'appointment-approved',
    subjectAt: '2026-09-05T10:00:00.000Z',
    created_at: '2026-09-01T09:00:00.000Z',
    read: false,
    ...overrides,
  };
}

const LABELS = {
  'appointment-requested': 'Your clinician has requested an appointment.',
  'appointment-approved': 'Your appointment is confirmed.',
  'appointment-cancelled': 'An appointment has been cancelled.',
  'calendar-updated': 'Your clinician has updated your calendar.',
};
const GENERIC = 'Something changed about your appointments.';

describe('notificationLabel', () => {
  it.each(Object.keys(LABELS))('renders the wording for %s', (kind) => {
    expect(notificationLabel(kind, LABELS, GENERIC)).toBe(LABELS[kind as keyof typeof LABELS]);
  });

  // The API and this site deploy separately, so a kind added server-side
  // reaches a browser running the previous build. A generic sentence is a
  // better answer there than a blank list item.
  it('falls back to the generic line for a kind this build has never heard of', () => {
    expect(notificationLabel('appointment-rescheduled', LABELS, GENERIC)).toBe(GENERIC);
  });

  it('does not pick up a label off Object.prototype', () => {
    // `kindLabels[kind]` on a plain object would otherwise resolve
    // `'toString'` to a function and render it.
    expect(notificationLabel('toString', LABELS, GENERIC)).toBe(GENERIC);
  });
});

describe('unreadOf', () => {
  it('keeps only what still needs attention', () => {
    const items = [
      notice({ notificationId: 'a', read: false }),
      notice({ notificationId: 'b', read: true }),
      notice({ notificationId: 'c', read: false }),
    ];
    expect(unreadOf(items).map((item) => item.notificationId)).toEqual(['a', 'c']);
  });

  it('is empty when everything has been dismissed', () => {
    expect(unreadOf([notice({ read: true })])).toEqual([]);
  });

  it('preserves the order it was given — the API already returns newest first', () => {
    const items = [notice({ notificationId: 'newer' }), notice({ notificationId: 'older' })];
    expect(unreadOf(items).map((item) => item.notificationId)).toEqual(['newer', 'older']);
  });
});
