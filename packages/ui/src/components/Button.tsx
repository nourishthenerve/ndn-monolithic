import type { ButtonHTMLAttributes, ReactNode } from 'react';

import { interactiveClassName } from './primitive-styles.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly children: ReactNode;
  readonly variant?: 'primary' | 'secondary';
  /**
   * 2026-09-08: `sm` for a control that sits *inside* a row of content — a
   * table cell's "Assign", a form's "Add row" — rather than being the thing
   * the page is for. Same pill and same two variants; only the padding and
   * the type size change, so a panel full of both still reads as one family.
   */
  readonly size?: 'md' | 'sm';
}

/** Semantic `<button>` — WCAG 2.5.8 tap target + token-driven `:focus-visible` come from the shared `interactiveClassName` (primitive-styles.ts), never inline `outline: none`. */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  type = 'button',
  className,
  ...rest
}: ButtonProps): ReactNode {
  const classes = [
    'ndn-button',
    `ndn-button--${variant}`,
    // No class for the default size: `.ndn-button` already carries it, and
    // an empty `.ndn-button--md` rule would be a selector with nothing on
    // the other side of it.
    size === 'sm' ? 'ndn-button--sm' : '',
    interactiveClassName,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type={type} className={classes} {...rest}>
      {children}
    </button>
  );
}
