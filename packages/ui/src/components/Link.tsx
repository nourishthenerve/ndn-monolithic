import type { AnchorHTMLAttributes, ReactNode } from 'react';

import { interactiveClassName } from './primitive-styles.js';

export interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  readonly children: ReactNode;
  readonly href: string;
  /** Adds `target="_blank"` + safe `rel`, and a screen-reader-only "(opens in a new tab)" suffix — never a silent new-tab open. */
  readonly external?: boolean;
}

export function Link({
  children,
  href,
  external = false,
  className,
  ...rest
}: LinkProps): ReactNode {
  const classes = ['ndn-link', interactiveClassName, className].filter(Boolean).join(' ');

  return (
    <a
      href={href}
      className={classes}
      target={external ? '_blank' : undefined}
      rel={external ? 'noopener noreferrer' : undefined}
      {...rest}
    >
      {children}
      {external ? <span className="ndn-visually-hidden"> (opens in a new tab)</span> : null}
    </a>
  );
}
