// @vitest-environment jsdom
//
// 2026-09-10: the next appointment in three zones with a live countdown. The
// zone formatting and the countdown arithmetic are tested where they live
// (`workshop-date`/`datetime` and `join-window`); what this pins is that the
// component wires the two together — three labelled zones, and a countdown
// that is minute-granular and never prints seconds — against an injected
// clock so the expectation does not depend on the wall clock the runner has.
import { defaultLocale, formatDateTimeInZone, t } from '@ndn/i18n';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { countdownUnits } from './countdown-units.js';
import { countdownUntil, formatCountdown } from './join-window.js';
import { NextAppointmentWhen } from './NextAppointmentWhen.js';

afterEach(cleanup);

const ISO = '2026-09-20T10:00:00.000Z';
/** A fixed clock, and stable across renders — the shape `useNow` requires. */
const at = (iso: string) => {
  const frozen = new Date(iso);
  return () => frozen;
};

describe('NextAppointmentWhen', () => {
  it('shows the instant in India, UK and Middle East time, each labelled', () => {
    render(<NextAppointmentWhen iso={ISO} locale={defaultLocale} now={at('2026-09-18T06:15:00.000Z')} />);

    // The labels are the catalogue's own — the same three the workshop pages show.
    expect(screen.getByText('India')).toBeTruthy();
    expect(screen.getByText('UK')).toBeTruthy();
    expect(screen.getByText('Middle East')).toBeTruthy();

    // A 10:00 UTC instant reads 3:30 PM in Kolkata, 11:00 AM in London (BST),
    // 2:00 PM in Dubai — each rendered by the shared zoned formatter.
    for (const zone of ['Asia/Kolkata', 'Europe/London', 'Asia/Dubai']) {
      expect(document.body.textContent).toContain(formatDateTimeInZone(ISO, defaultLocale, zone));
    }
    expect(document.body.textContent).not.toContain(ISO);
  });

  it('counts down in days, hours and minutes — never seconds', () => {
    const now = at('2026-09-18T06:15:00.000Z');
    render(<NextAppointmentWhen iso={ISO} locale={defaultLocale} now={now} />);

    // 2 days, 3 hours and 45 minutes out.
    const countdown = countdownUntil(new Date(ISO), now());
    expect(countdown).toEqual({ days: 2, hours: 3, minutes: 45 });
    const expected = t(
      'appointment.notStarted',
      { countdown: formatCountdown(countdown!, countdownUnits(defaultLocale)) },
      defaultLocale,
    );
    expect(screen.getByText(expected)).toBeTruthy();
    expect(expected).toContain('45 minutes');
    expect(expected).not.toMatch(/second/i);
    // No clock-style seconds figure either.
    expect(expected).not.toMatch(/:\d\d/);
  });

  it('drops the countdown once the appointment has started', () => {
    render(<NextAppointmentWhen iso={ISO} locale={defaultLocale} now={at('2026-09-20T10:30:00.000Z')} />);

    // The zoned times still show; there is simply nothing left to count down.
    expect(screen.getByText('UK')).toBeTruthy();
    expect(screen.queryByText(/Starts in/)).toBeNull();
  });
});
