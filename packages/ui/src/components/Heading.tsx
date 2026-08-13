import type { HTMLAttributes, ReactNode } from 'react';

export interface HeadingProps extends HTMLAttributes<HTMLHeadingElement> {
  /** The semantic heading level — callers choose this from document structure, never from desired size (use CSS for that). */
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly children: ReactNode;
}

const tagByLevel = {
  1: 'h1',
  2: 'h2',
  3: 'h3',
  4: 'h4',
  5: 'h5',
  6: 'h6',
} as const;

export function Heading({ level, children, className, ...rest }: HeadingProps): ReactNode {
  const Tag = tagByLevel[level];
  const classes = ['ndn-heading', className].filter(Boolean).join(' ');

  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
