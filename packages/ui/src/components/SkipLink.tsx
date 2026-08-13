import type { AnchorHTMLAttributes, ReactNode } from 'react';

import { interactiveClassName } from './primitive-styles.js';

export interface SkipLinkProps extends Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> {
  readonly children: ReactNode;
  /** The id of the page's `<main>` landmark — defaults to `#main`, set once by `BaseLayout` (TASK 1.2.1). */
  readonly targetId?: string;
}

/**
 * Off-screen until focused, per WCAG 2.4.1 — must be the first focusable
 * element on the page (a layout's job, not this component's) so a
 * keyboard/screen-reader user can jump past repeated navigation straight
 * to `<main>`.
 */
export function SkipLink({
  children,
  targetId = 'main',
  className,
  ...rest
}: SkipLinkProps): ReactNode {
  const classes = ['ndn-skip-link', interactiveClassName, className].filter(Boolean).join(' ');

  return (
    <a href={`#${targetId}`} className={classes} {...rest}>
      {children}
    </a>
  );
}
