// TASK 1.1.1: one shared stylesheet for every primitive in this directory.
// Kept as an exported string (same pattern as tokens/motion.ts's
// `reducedMotionGlobalCss`) rather than a `.css` file so it can be
// unit-tested directly (parsed as text) without a bundler, and injected by
// a consumer via a single `<style set:html={primitiveStylesCss}>`.

import { minInteractiveTargetPx } from '../tokens/space.js';

export const interactiveClassName = 'ndn-interactive';
export const visuallyHiddenClassName = 'ndn-visually-hidden';

export const primitiveStylesCss = `
body {
  font-family: var(--ndn-font-family-base);
  color: var(--ndn-color-text);
  margin: 0;
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
  padding: 0.625rem 1.25rem;
  border-radius: 0.375rem;
  border: 1px solid transparent;
  font-family: var(--ndn-font-family-base);
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color var(--ndn-motion-duration-fast) ease,
    border-color var(--ndn-motion-duration-fast) ease;
}

.ndn-button--primary {
  background-color: var(--ndn-color-brand);
  color: #ffffff;
}

.ndn-button--secondary {
  background-color: transparent;
  color: var(--ndn-color-brand);
  border-color: var(--ndn-color-brand);
}

.ndn-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.ndn-link {
  display: inline-flex;
  align-items: center;
  color: var(--ndn-color-brand);
  text-decoration: underline;
  text-underline-offset: 0.15em;
}

.ndn-input-wrapper {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.ndn-input-label {
  font-size: 0.875rem;
  font-weight: 500;
  color: var(--ndn-color-text);
}

.ndn-input {
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--ndn-color-text-muted);
  border-radius: 0.375rem;
  font-size: 1rem;
  color: var(--ndn-color-text);
  background-color: #ffffff;
}

.ndn-input[aria-invalid='true'] {
  border-color: var(--ndn-color-error);
}

.ndn-input-error {
  font-size: 0.875rem;
  color: var(--ndn-color-error);
}

.ndn-card {
  padding: 1.5rem;
  border-radius: 0.5rem;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background-color: #ffffff;
}

.ndn-heading {
  color: var(--ndn-color-text);
  font-weight: 700;
  line-height: 1.2;
}

.ndn-skip-link {
  position: absolute;
  left: 0.5rem;
  top: -3rem;
  z-index: 100;
  padding: 0.625rem 1rem;
  background-color: var(--ndn-color-brand);
  color: #ffffff;
  border-radius: 0.375rem;
  text-decoration: none;
  transition: top var(--ndn-motion-duration-fast) ease;
}

.ndn-skip-link:focus {
  top: 0.5rem;
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
`;
