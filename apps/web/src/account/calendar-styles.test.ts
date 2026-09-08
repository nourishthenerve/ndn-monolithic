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

  // 2026-09-07, reported as today's square overlapping the next day.
  //
  // `.ndn-cal-day` is a <button> on a day with appointments and a <span> on
  // one without. The UA stylesheet gives form controls `border-box` and
  // gives a span nothing, this project has no global reset, and the rule
  // sets `width: 100%` with horizontal padding — so the span's border box
  // was 0.75rem wider than its cell and overhung the neighbouring day.
  // Nothing painted that edge except the today ring, which is why exactly
  // one square in the grid ever showed it.
  it('sizes a day square with border-box, so the span and the button agree', () => {
    const dayRule = appointmentCalendarStylesCss.slice(
      appointmentCalendarStylesCss.indexOf('.ndn-cal-day {'),
      appointmentCalendarStylesCss.indexOf('.ndn-cal-day--busy {'),
    );
    expect(dayRule).toContain('box-sizing: border-box');
    // The pairing that made it a bug: either one alone is harmless.
    expect(dayRule).toContain('width: 100%');
    expect(dayRule).toContain('padding: 0.375rem');
  });

  // 2026-09-06: the banner that appears when a call is open.
  it('marks the live appointment in both the chip and the dot rendering', () => {
    // A phone shows dots instead of chips, and "a call is open right now" is
    // exactly the thing that must not be the one fact only a wide screen
    // carries.
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-chip--live');
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-dot--live');
  });

  it('puts the live marks last, so they win over the status rule on the same chip', () => {
    // `--live` is not a sixth status but a state a confirmed appointment
    // passes through, so both classes land on one element and source order
    // is what decides. Written as a check on order rather than on presence:
    // moving these rules up the file would silently restore the green.
    for (const status of KNOWN_STATUSES) {
      expect(
        appointmentCalendarStylesCss.indexOf('.ndn-cal-chip--live'),
        `the live chip rule must come after .ndn-cal-chip--${status}`,
      ).toBeGreaterThan(appointmentCalendarStylesCss.indexOf(`.ndn-cal-chip--${status}`));
      expect(
        appointmentCalendarStylesCss.indexOf('.ndn-cal-dot--live'),
        `the live dot rule must come after .ndn-cal-dot--${status}`,
      ).toBeGreaterThan(appointmentCalendarStylesCss.indexOf(`.ndn-cal-dot--${status}`));
    }
  });

  it('beats packages/ui’s own .ndn-link on specificity rather than on source order', () => {
    // `Link` carries `.ndn-link`, which sets a brand colour and an
    // underline. The two stylesheets are injected by different parts of the
    // layout, so a rule that only wins because of where it lands stops
    // winning the moment something moves.
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-live .ndn-cal-live-join');
  });

  // 2026-09-08: the mark that appears while a newer window is being fetched
  // and the month underneath is deliberately left standing.
  it('gives the refresh mark a row of its own beside the range, and keeps it quiet', () => {
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-range');
    expect(appointmentCalendarStylesCss).toContain('.ndn-cal-refreshing');
    // Muted, not brand: this appears for a few hundred milliseconds on every
    // arrow press, and something loud at that frequency is worse than the
    // flicker it replaced.
    expect(appointmentCalendarStylesCss).toMatch(
      /\.ndn-cal-refreshing \{[^}]*color: var\(--ndn-color-text-muted\)/,
    );
  });

  it('does not fade the stale grid, which is how muted text drops below 4.5:1', () => {
    // `aria-busy` and the mark above are what say a newer window is coming.
    // An opacity on the grid would take the past-day rule's muted token with
    // it — this stylesheet's own note on why past days are muted rather than
    // faded.
    expect(appointmentCalendarStylesCss).not.toMatch(
      /\.ndn-cal-scroll\[aria-busy[^}]*opacity/,
    );
  });

  it('carries no backtick, which would end the template literal it lives in', () => {
    expect(appointmentCalendarStylesCss).not.toContain('`');
  });
});
