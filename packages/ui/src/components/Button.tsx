import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { interactiveClassName } from './primitive-styles.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'secondary';
}

/** Semantic `<button>` — WCAG 2.5.8 tap target + token-driven `:focus-visible` come from the shared `interactiveClassName` (primitive-styles.ts), never inline `outline: none`. */
export function Button({
  children,
  variant = 'primary',
  type = 'button',
  className,
  ...rest
}: ButtonProps): ReactNode {
  const classes = ['ndn-button', `ndn-button--${variant}`, interactiveClassName, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
