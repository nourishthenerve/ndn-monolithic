// 2026-09-06: the month calendar's stylesheet, as an exported string.
//
// The same shape `packages/ui`'s `primitiveStylesCss` uses, and for two of
// the same reasons: it can be unit-tested as text without a bundler, and the
// page injects it with one `<style set:html>` — which is what this codebase's
// CSP requires, since an island cannot ship its own inline `<style>` and be
// sure of surviving it (`auth/csp-inline-scripts.test.ts` documents the
// script half of that lesson).
//
// It is a **separate module from `AppointmentCalendar.tsx` on purpose.** The
// component is a `client:only` island, so everything its module imports ends
// up in the browser bundle; the page needs this string at build time only.
// Keeping them apart means the CSS ships once, as CSS, rather than also as a
// string literal inside the JavaScript.
//
// No backticks anywhere inside: this is a template literal, and one would
// end it mid-stylesheet. (A comment saying so is cheaper than the build
// failure it prevents — that mistake was made twice on the landing page.)

export const appointmentCalendarStylesCss = `
.ndn-cal {
  margin-block-end: 2rem;
}

.ndn-cal-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.ndn-cal-bar h2 {
  margin: 0;
}

.ndn-cal-nav {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.ndn-cal-step,
.ndn-cal-today {
  /* Well past WCAG 2.2 SC 2.5.8's 24px floor: these are the controls the
     whole view is driven by, and on a phone they are pressed with a thumb. */
  min-height: 2.75rem;
  min-width: 2.75rem;
  padding-inline: 0.75rem;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: 0.5rem;
  background-color: #ffffff;
  color: var(--ndn-color-text);
  font: inherit;
  cursor: pointer;
  transition: border-color var(--ndn-motion-duration-fast) ease;
}

.ndn-cal-step:hover,
.ndn-cal-today:hover {
  border-color: var(--ndn-color-brand);
}

/* Restated rather than inherited from .ndn-interactive: these are plain
   <button>s, deliberately not packages/ui's Button — see the component. */
.ndn-cal-step:focus-visible,
.ndn-cal-today:focus-visible,
.ndn-cal-day--busy:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

.ndn-cal-month {
  margin-block: 0.75rem 0.75rem;
  font-size: 1.125rem;
  font-weight: 500;
}

/* The grid never needs to scroll at 390px — seven 20rem/7 columns hold a
   day number and a "14:30" chip — but a 320px viewport, or a reader at 200%
   text zoom, is exactly where a table quietly overflows the page instead. */
.ndn-cal-scroll {
  overflow-x: auto;
}

.ndn-cal-grid {
  width: 100%;
  min-width: 20rem;
  border-collapse: collapse;
  table-layout: fixed;
}

.ndn-cal-grid th {
  padding-block: 0.5rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--ndn-color-text-muted);
  text-align: center;
}

.ndn-cal-cell {
  padding: 0;
  border: 1px solid rgba(0, 0, 0, 0.08);
  vertical-align: top;
}

.ndn-cal-cell--selected {
  background-color: rgba(10, 110, 90, 0.08);
}

.ndn-cal-day {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.25rem;
  width: 100%;
  min-height: 4.5rem;
  padding: 0.375rem;
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: start;
  color: inherit;
}

.ndn-cal-day--busy {
  border: 0;
  background: none;
  cursor: pointer;
  border-radius: 0.25rem;
  transition: background-color var(--ndn-motion-duration-fast) ease;
}

/* The only thing distinguishing a pressable square from an empty one is that
   it has something in it. A hover state says so before the press. */
.ndn-cal-day--busy:hover {
  background-color: rgba(10, 110, 90, 0.06);
}

/* A rolling window has no "days from the next month" to grey out — every
   square is equally part of the view. What is marked instead is the split
   this view exists to straddle: days already past read muted, days ahead
   read full strength, so the boundary between history and what is coming is
   visible without reading a single date.

   Muted rather than faded: opacity on top of a muted token is how text
   quietly drops below 4.5:1. */
.ndn-cal-cell--past .ndn-cal-day {
  color: var(--ndn-color-text-muted);
}

.ndn-cal-cell--today .ndn-cal-day {
  box-shadow: inset 0 0 0 2px var(--ndn-color-brand);
  border-radius: 0.25rem;
}

.ndn-cal-chips {
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
}

.ndn-cal-chip {
  overflow: hidden;
  padding-inline: 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.6875rem;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
  background-color: rgba(10, 110, 90, 0.12);
  color: #06483b;
}

.ndn-cal-chip--pending-approval {
  background-color: rgba(146, 94, 0, 0.14);
  color: #5c3b00;
}

.ndn-cal-chip--completed {
  background-color: rgba(0, 0, 0, 0.07);
  color: #3f4650;
}

.ndn-cal-chip--no-show {
  background-color: rgba(179, 38, 30, 0.12);
  color: #8a1d17;
}

.ndn-cal-chip--cancelled {
  background-color: rgba(0, 0, 0, 0.07);
  color: #3f4650;
  text-decoration: line-through;
}

/* The narrow-screen stand-in for the time chips — see the component. One dot
   per appointment, coloured by the same status palette, so a glance still
   tells you which days are busy and roughly with what. */
.ndn-cal-dots {
  display: none;
  flex-wrap: wrap;
  gap: 0.1875rem;
}

.ndn-cal-dot {
  width: 0.4375rem;
  height: 0.4375rem;
  border-radius: 50%;
  background-color: #0a6e5a;
}

.ndn-cal-dot--pending-approval {
  background-color: #925e00;
}

.ndn-cal-dot--completed,
.ndn-cal-dot--cancelled {
  background-color: #6b7280;
}

.ndn-cal-dot--no-show {
  background-color: #b3261e;
}

/* A seventh of a phone is about 38px of usable cell, where "9:30 AM"
   truncates to "9:3…". Below this width the dots take over and the rows get
   shorter, since they no longer have to hold stacked text. */
@media (max-width: 34rem) {
  .ndn-cal-chips {
    display: none;
  }

  .ndn-cal-dots {
    display: flex;
  }

  .ndn-cal-day {
    min-height: 3.25rem;
  }
}

.ndn-cal-day-panel {
  margin-block-start: 1.25rem;
}

.ndn-cal-day-heading {
  margin-block: 0 0.5rem;
  font-size: 1rem;
}

.ndn-cal-day-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ndn-cal-day-list > li {
  padding-block: 0.75rem;
  padding-inline: 1rem;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 0.5rem;
  background-color: #ffffff;
}

.ndn-cal-when {
  margin-block: 0 0.25rem;
  font-weight: 500;
}

.ndn-cal-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1rem;
  margin-block: 0 0.5rem;
  color: var(--ndn-color-text-muted);
  font-size: 0.875rem;
}

.ndn-cal-day-list > li p:last-child {
  margin-block-end: 0;
}

/* The decisions a clinician can take on a slot, inherited from the deleted
   account/calendar page. A row of small controls rather than the panel's
   only action, so they wrap on a phone instead of stretching. (No backticks
   in here: this block is a template literal.) */
.ndn-cal-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin-block: 0.75rem 0;
}

.ndn-cal-action {
  min-height: 2.25rem;
  padding-block: 0.375rem;
  padding-inline: 0.75rem;
  border: 1px solid rgba(0, 0, 0, 0.16);
  border-radius: 0.375rem;
  background-color: #ffffff;
  color: var(--ndn-color-text);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  transition: border-color var(--ndn-motion-duration-fast) ease;
}

.ndn-cal-action:hover:not(:disabled) {
  border-color: var(--ndn-color-brand);
}

.ndn-cal-action:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.ndn-cal-action:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}
`;
