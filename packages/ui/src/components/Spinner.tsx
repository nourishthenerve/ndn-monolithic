import type { HTMLAttributes, ReactNode } from 'react';

export interface SpinnerProps extends HTMLAttributes<HTMLSpanElement> {
  readonly size?: 'sm' | 'md' | 'lg';
}

/**
 * 2026-09-08: the ring that turns while something is being fetched.
 *
 * Deliberately `aria-hidden` and deliberately unlabelled. A spinner is a
 * picture of waiting, not a statement of it — the statement is the text
 * beside it, which is what `Loading` pairs this with. A spinner carrying its
 * own `role="status"` and its own "Loading" name would announce the wait
 * twice, once for the picture and once for the sentence.
 *
 * Motion lives in `primitive-styles.ts`, so `reducedMotionGlobalCss` reaches
 * it like every other animation on the site: under `prefers-reduced-motion`
 * the ring settles and stops, and the sentence beside it still says what is
 * happening.
 */
export function Spinner({ size = 'md', className, ...rest }: SpinnerProps): ReactNode {
  const classes = ['ndn-spinner', `ndn-spinner--${size}`, className].filter(Boolean).join(' ');

  return <span className={classes} aria-hidden="true" {...rest} />;
}
