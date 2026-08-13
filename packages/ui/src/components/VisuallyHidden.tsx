import type { HTMLAttributes, ReactNode } from 'react';

import { visuallyHiddenClassName } from './primitive-styles.js';

export interface VisuallyHiddenProps extends HTMLAttributes<HTMLSpanElement> {
  readonly children: ReactNode;
}

/** Content read by assistive tech but never rendered visually — e.g. the full label behind an icon-only control. Not `display: none`, which screen readers skip too. */
export function VisuallyHidden({ children, className, ...rest }: VisuallyHiddenProps): ReactNode {
  const classes = [visuallyHiddenClassName, className].filter(Boolean).join(' ');

  return (
    <span className={classes} {...rest}>
      {children}
    </span>
  );
}
