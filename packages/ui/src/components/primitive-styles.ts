// TASK 1.1.1: one shared stylesheet for every primitive in this directory.
// Kept as an exported string (same pattern as tokens/motion.ts's
// `reducedMotionGlobalCss`) rather than a `.css` file so it can be
// unit-tested directly (parsed as text) without a bundler, and injected by
// a consumer via a single `<style set:html={primitiveStylesCss}>`.
//
// ## 2026-09-07: this file is where the theme lands
//
// The owner asked for the olive-and-lavender look to reach *every* page, not
// just the landing page. Twenty-five of this site's twenty-six routes have no
// stylesheet of their own — they are `<BaseLayout>` plus primitives — so the
// honest way to do that was to theme the primitives rather than to write
// twenty-five page stylesheets. Everything below is driven by
// `tokens/color.ts`'s custom properties; there is no raw hex in this file, so
// a future palette change is a change to that file alone.
//
// Three things here are deliberate rather than incidental:
//
//   * `body` paints `--ndn-color-surface` (warm paper), and cards, inputs and
//     the header paint `--ndn-color-surface-raised` (white) on top of it.
//     That one-step separation is what lets a card read as a card without a
//     heavy border or a drop shadow, which is the whole visual argument of
//     both reference sites.
//   * Headings are the display serif; everything a reader has to work
//     through — prose, labels, controls, tables — stays Inter. See
//     `tokens/type.ts`.
//   * Buttons are pills. A 999px radius on a control this size reads as
//     "considered" rather than "styled", and it is the one shape choice that
//     carries across the account pages' plain `<button>`s too, via the
//     `.ndn-button` class they already use.

import { minInteractiveTargetPx } from '../tokens/space.js';

export const interactiveClassName = 'ndn-interactive';
export const visuallyHiddenClassName = 'ndn-visually-hidden';

export const primitiveStylesCss = `
body {
  font-family: var(--ndn-font-family-base);
  color: var(--ndn-color-text);
  background-color: var(--ndn-color-surface);
  margin: 0;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

::selection {
  background-color: var(--ndn-color-accent-soft);
  color: var(--ndn-color-text);
}

.${interactiveClassName} {
  min-height: ${minInteractiveTargetPx}px;
  min-width: ${minInteractiveTargetPx}px;
}

.${interactiveClassName}:focus-visible {
  outline: 2px solid var(--ndn-color-focus-ring);
  outline-offset: 2px;
}

.ndn-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding-block: 0.625rem;
  padding-inline: 1.375rem;
  border-radius: 999px;
  border: 1px solid transparent;
  font-family: var(--ndn-font-family-base);
  font-size: 1rem;
  font-weight: 500;
  letter-spacing: 0.005em;
  cursor: pointer;
  transition: background-color var(--ndn-motion-duration-fast) ease,
    border-color var(--ndn-motion-duration-fast) ease,
    color var(--ndn-motion-duration-fast) ease;
}

.ndn-button--primary {
  background-color: var(--ndn-color-brand);
  color: var(--ndn-color-surface-raised);
}

.ndn-button--primary:hover:not(:disabled) {
  background-color: var(--ndn-color-brand-strong);
}

.ndn-button--secondary {
  background-color: transparent;
  color: var(--ndn-color-brand);
  border-color: var(--ndn-color-border-strong);
}

.ndn-button--secondary:hover:not(:disabled) {
  background-color: var(--ndn-color-brand-wash);
  border-color: var(--ndn-color-brand);
  color: var(--ndn-color-brand-strong);
}

.ndn-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 2026-09-08: the smaller pill. Sized against WCAG 2.2 SC 2.5.8 the same way
   the calendar's and the caseload's own row controls already are — 2.25rem is
   comfortably past the 24px floor — so a table cell can hold one without the
   row growing to fit it. */
.ndn-button--sm {
  min-height: 2.25rem;
  padding-block: 0.375rem;
  padding-inline: 0.875rem;
  font-size: 0.875rem;
}

/* A press that moves under the pointer. Cheap, and it is the difference
   between a control that feels connected to what happens next and one that
   feels like a picture of a control — which is the whole complaint that
   started this pass. Not a transition: the answer has to be immediate. */
.ndn-button:active:not(:disabled) {
  transform: translateY(1px);
}

/* ## 2026-09-08: waiting states
 *
 * The account dashboard resolves a session, then every panel on it fetches
 * its own data — so signing in gave a column of headings with the word
 * "Loading…" under each, and then a run of layout jumps as the answers
 * landed one at a time. These three classes are what stands in the meantime:
 * a ring that says the wait is progressing, and skeleton shapes in the
 * outline of what is coming so the page holds still while it arrives.
 *
 * Both animations carry literal durations rather than the motion custom
 * properties, because 120-320ms is a transition scale and neither of these
 * is a transition — a ring that completes a turn every 120ms is a smear.
 * tokens/motion.ts still reaches them: its reduce block sets
 * animation-duration and iteration-count on every element with !important,
 * precisely so a component that does not use the custom properties is
 * covered anyway. The sheen is additionally switched off by hand below,
 * so a stopped skeleton settles as a flat tint rather than at whatever
 * gradient position a 0.01ms run happened to end on.
 *
 * (No backticks in this block: it is a JS template literal.) */
.ndn-loading {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.ndn-loading-note {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  color: var(--ndn-color-text-muted);
  font-size: 0.9375rem;
}

.ndn-spinner {
  display: inline-block;
  flex: none;
  box-sizing: border-box;
  width: 1.125rem;
  height: 1.125rem;
  /* The heavier hairline for the track, not the brand tint: at 18px across
     and 2px thick a soft-on-paper ring is very close to invisible, which
     was the first thing a rendered check of this showed. */
  border: 2px solid var(--ndn-color-border-strong);
  /* One quadrant in the full brand colour is what makes the rotation
     readable; a ring of one colour turning looks like a ring standing
     still. */
  border-block-start-color: var(--ndn-color-brand);
  border-radius: 50%;
  animation: ndn-spin 700ms linear infinite;
}

.ndn-spinner--sm {
  width: 0.875rem;
  height: 0.875rem;
}

.ndn-spinner--lg {
  width: 1.75rem;
  height: 1.75rem;
  border-width: 3px;
}

.ndn-skeleton {
  display: block;
  border-radius: 0.375rem;
  background-color: var(--ndn-color-neutral-soft);
  /* A narrow highlight travelling across a shape that stays tinted — not a
     tint travelling across a shape that is mostly white. The flat runs
     either side of the 50% stop are what keep it narrow: a three-stop
     gradient at this background-size put a highlight wider than the element
     itself over every skeleton, so the whole placeholder read as blank
     paper rather than as a shape holding a space. */
  background-image: linear-gradient(
    90deg,
    var(--ndn-color-neutral-soft) 0%,
    var(--ndn-color-neutral-soft) 42%,
    var(--ndn-color-surface-raised) 50%,
    var(--ndn-color-neutral-soft) 58%,
    var(--ndn-color-neutral-soft) 100%
  );
  background-size: 220% 100%;
  animation: ndn-skeleton-sheen 1600ms ease-in-out infinite;
}

.ndn-skeleton--line {
  height: 0.75rem;
}

.ndn-skeleton--heading {
  height: 1.25rem;
  border-radius: 0.5rem;
}

.ndn-skeleton--block {
  height: 3rem;
  border-radius: 0.5rem;
}

.ndn-skeleton--pill {
  height: 2.5rem;
  border-radius: 999px;
}

/* A stack of skeleton lines, and the horizontal rows the panels build from
   them. Here rather than in a page stylesheet because every consumer of
   Skeleton wants the same two arrangements. */
.ndn-skeleton-stack {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.ndn-skeleton-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

/* A skeleton is an empty element, so block layout in a flex row would give
   it no width at all. A floor rather than a grow factor, so a caller that
   passes an explicit width still gets the width it asked for. */
.ndn-skeleton-row > .ndn-skeleton {
  flex: 0 1 auto;
  min-width: 4rem;
}

/* A label above its control — the shape of every field on the account
   forms, and the reason a form placeholder does not read as a stack of
   unrelated bars. */
.ndn-skeleton-field {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
}

/* Seven columns, because the one grid on this site is a week. Held here
   with the other skeleton arrangements rather than in the calendar's own
   stylesheet: the placeholder has to be drawable before the calendar
   island has loaded at all. */
.ndn-skeleton-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.25rem;
}

@keyframes ndn-spin {
  to {
    transform: rotate(1turn);
  }
}

@keyframes ndn-skeleton-sheen {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -100% 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  /* The global block already collapses the animation to nothing; without
     this the shape would freeze at whichever slice of the gradient a 0.01ms
     run left under it. A flat tint is the honest still frame. */
  .ndn-skeleton {
    background-image: none;
  }
}

.ndn-link {
  display: inline-flex;
  align-items: center;
  color: var(--ndn-color-brand);
  text-decoration: underline;
  /* A hairline at a real distance from the baseline, rather than the
     browser's default rule sitting on the descenders — the single cheapest
     thing that makes a page of links look set rather than rendered. */
  text-decoration-thickness: 1px;
  text-underline-offset: 0.2em;
  text-decoration-color: var(--ndn-color-border-strong);
  transition: color var(--ndn-motion-duration-fast) ease,
    text-decoration-color var(--ndn-motion-duration-fast) ease;
}

.ndn-link:hover {
  color: var(--ndn-color-brand-strong);
  text-decoration-color: var(--ndn-color-brand);
}

.ndn-input-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0.3125rem;
}

.ndn-input-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ndn-color-text);
}

.ndn-input {
  padding-block: 0.625rem;
  padding-inline: 0.875rem;
  border: 1px solid var(--ndn-color-text-muted);
  border-radius: 0.5rem;
  font-size: 1rem;
  color: var(--ndn-color-text);
  background-color: var(--ndn-color-surface-raised);
  transition: border-color var(--ndn-motion-duration-fast) ease;
}

.ndn-input:hover:not(:disabled) {
  border-color: var(--ndn-color-brand);
}

.ndn-input[aria-invalid='true'] {
  border-color: var(--ndn-color-error);
}

.ndn-input-error {
  font-size: 0.875rem;
  color: var(--ndn-color-error);
}

/* 2026-09-08: a panel's own action and whatever it last said about saving,
   on one line. Every account form ended in a paragraph holding exactly that
   pair, with a single space between a pill and a sentence. Global rather
   than in a page stylesheet because those panels are mounted from four
   different pages, and a shape that only lined up on one of them would be
   worse than the space. */
.ndn-panel-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
  margin-block: 1.25rem 0;
}

/* 2026-09-08: a checkbox and its own label, which the Input primitive does
   not model — the label wraps the control rather than sitting above it, so
   it cannot use .ndn-input-wrapper. Here rather than in an account
   stylesheet because the shape is the same wherever a tick box appears. */
.ndn-checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ndn-color-text);
}

.ndn-card {
  padding: 1.5rem;
  border-radius: 0.875rem;
  border: 1px solid var(--ndn-color-border);
  background-color: var(--ndn-color-surface-raised);
}

/* 2026-09-07: the publication date on a blog card, a workshop card and an
   article's own byline. Smaller and quieter than the text it sits above,
   because it is context for the thing being read rather than part of it —
   and the palette's own muted text token rather than a lighter grey
   invented here, so it keeps the contrast ratio that token guarantees.
   (No backticks in this block: it is a JS template literal.) */
.ndn-card-meta {
  margin-block: 0 0.75rem;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ndn-color-text-muted);
}

/* 2026-09-07: a workshop's start time in each of the three regions it is
   announced to (India, UK, Middle East). A description list, because
   region-to-time is a description list — and a two-column grid so the
   labels line up down the card instead of the times ragging.

   The row wrapper is a div so React can key it; display:contents is what
   keeps the grid seeing the dt/dd pairs rather than the wrappers. Same
   trick, and same reason, as the astro-island rule the homepage documents.
   (No backticks in this block: it is a JS template literal.) */
.ndn-card-times {
  display: grid;
  grid-template-columns: auto 1fr;
  column-gap: 0.75rem;
  row-gap: 0.125rem;
  margin-block: 0 0.75rem;
  padding-inline-start: 0.875rem;
  border-inline-start: 2px solid var(--ndn-color-accent-soft);
  font-size: 0.875rem;
  color: var(--ndn-color-text-muted);
}

.ndn-card-times > div {
  display: contents;
}

.ndn-card-times dt {
  font-weight: 500;
}

.ndn-card-times dd {
  margin: 0;
}

/* The display serif, on every heading the site renders — packages/ui's
   Heading is the only way a heading is written here, so this one rule is the
   whole of it. Sizes are set per level below rather than left to the browser,
   because the user-agent scale (2em, 1.5em, 1.17em...) was tuned for a
   body-copy serif and reads as a jump-cut next to Cormorant. */
.ndn-heading {
  color: var(--ndn-color-text);
  font-family: var(--ndn-font-family-display);
  font-weight: var(--ndn-font-weight-display);
  line-height: 1.15;
  letter-spacing: -0.005em;
  text-wrap: balance;
}

h1.ndn-heading {
  font-size: clamp(2rem, 4.5vw, 2.75rem);
  margin-block: 0 1rem;
}

h2.ndn-heading {
  font-size: clamp(1.625rem, 3vw, 2rem);
  margin-block: 2rem 0.75rem;
}

h3.ndn-heading {
  font-size: 1.3125rem;
  margin-block: 1.5rem 0.5rem;
}

h4.ndn-heading,
h5.ndn-heading,
h6.ndn-heading {
  font-size: 1.0625rem;
  margin-block: 1.25rem 0.5rem;
}

/* A heading that opens a card, a panel or the page itself has the
   container's own padding above it already; a second margin there reads as
   a mistake. */
.ndn-heading:first-child {
  margin-block-start: 0;
}

.ndn-skip-link {
  position: absolute;
  inset-inline-start: 0.5rem;
  inset-block-start: -3rem;
  z-index: 100;
  padding-block: 0.625rem;
  padding-inline: 1rem;
  background-color: var(--ndn-color-brand);
  color: var(--ndn-color-surface-raised);
  border-radius: 999px;
  text-decoration: none;
  transition: inset-block-start var(--ndn-motion-duration-fast) ease;
}

.ndn-skip-link:focus {
  inset-block-start: 0.5rem;
}

.${visuallyHiddenClassName} {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.ndn-cookie-banner {
  position: fixed;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: 200;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-block: 1rem;
  padding-inline: 1.5rem;
  background-color: var(--ndn-color-surface-raised);
  border-block-start: 1px solid var(--ndn-color-border);
  box-shadow: 0 -1px 24px var(--ndn-color-border);
}

.ndn-cookie-banner-message {
  flex: 1 1 20rem;
  margin: 0;
  color: var(--ndn-color-text);
  font-size: 0.875rem;
}

.ndn-cookie-banner-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75rem;
}

/* Author-stylesheet class rules always beat the user-agent stylesheet's
 * own \`[hidden] { display: none }\`, even at equal (0,1,0) specificity —
 * author origin outranks user-agent origin in the cascade regardless of a
 * specificity tie. Without this explicit override, \`.ndn-cookie-banner\`'s
 * own \`display: flex\` above would silently defeat the native \`hidden\`
 * attribute apps/web's wiring script relies on — confirmed as a real,
 * reproducing bug (banner stayed visible after accept/reject) against a
 * live \`astro preview\` before this rule was added. \`(0,2,0)\`, higher than
 * \`.ndn-cookie-banner\` alone, so it wins whenever the attribute is set. */
.ndn-cookie-banner[hidden] {
  display: none;
}
`;
