import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLElement> {
  readonly children: ReactNode;
}

/** A grouping container — semantic `<article>`, not `<div>`, since a card always holds one self-contained piece of content (a blog teaser, a workshop, a testimonial). */
export function Card({ children, className, ...rest }: CardProps): ReactNode {
  const classes = ['ndn-card', className].filter(Boolean).join(' ');

  return (
    <article className={classes} {...rest}>
      {children}
    </article>
  );
}
