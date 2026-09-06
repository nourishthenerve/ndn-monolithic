import { describe, expect, it } from 'vitest';

import { appointmentCalendarStylesCss } from './calendar-styles.js';

// 2026-09-06: a stylesheet held as a string can be read as text, which is
// the reason `packages/ui`'s `primitiveStylesCss` is one too.
//
// **What this list is, and what it is not.** `AppointmentStatus` lives in
// `packages/shared-types/src/appointment.ts`, which `apps/web` does not
// depend on — every account island types these as a plain `string` and the
// account page maps them by hand. So this is a *mirror*, and nothing makes
// the compiler check it: a sixth status added upstream will not fail here.
// It still earns its place for the failure it does catch — a chip class
// renamed or dropped while the component still emits it, which would render
// that status as the default green and make, say, a cancelled appointment
// look confirmed.
const KNOWN_STATUSES = ['pending-approval', 'completed', 'cancelled', 'no-show'];

describe('appointmentCalendarStylesCss', () => {
  it('gives every non-default appointment status its own chip rule', () => {
    for (const status of KNOWN_STATUSES) {
      expect(
        appointmentCalendarStylesCss,
        `no chip style for the "${status}" status — it would render as a confirmed one`,
      ).toContain(`.ndn-cal-chip--${status}`);
    }
  });

  it('gives every non-default status a dot rule too, since narrow screens show those instead', () => {
    for (const status of KNOWN_STATUSES) {
      expect(
        appointmentCalendarStylesCss,
        `no dot style for the "${status}" status — on a phone it would be indistinguishable from a confirmed one`,
      ).toContain(`.ndn-cal-dot--${status}`);
    }
  });

  it('swaps chips for dots below the narrow breakpoint, rather than truncating a time to nothing', () => {
    // "9:30 AM" in a seventh of a 390px phone renders as "9:3…".
    expect(appointmentCalendarStylesCss).toContain('@media (max-width: 34rem)');
  });

  it('has a base chip rule for the ordinary, confirmed case', () => {
    // `scheduled` is deliberately the base rule rather than a modifier: a
    // confirmed appointment is the ordinary case, so it is the default the
    // others vary from.
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-chip {');
  });

  it('restates a focus outline for its own plain buttons', () => {
    // They are deliberately not `packages/ui`'s `Button`, so they inherit
    // none of `.ndn-interactive`'s focus styling — see the component.
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-step:focus-visible');
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-day--busy:focus-visible');
  });

  it('marks past days rather than out-of-month ones, which a rolling window has none of', () => {
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-cell--past');
    expect(appointmentCalendarStylesCss).not.toContain('.ndn-cal-cell--outside');
  });

  it('keeps the day controls above the WCAG 2.2 target-size floor', () => {
    expect(appointmentCalendarStylesCss).toContain('min-height: 2.75rem');
  });

  it('carries no backtick, which would end the template literal it lives in', () => {
    expect(appointmentCalendarStylesCss).not.toContain('`');
  });
});
