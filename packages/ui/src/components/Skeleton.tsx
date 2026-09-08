import type { HTMLAttributes, ReactNode } from 'react';

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  /** The rough outline of the thing being waited for — a line of prose, a heading, a block, or a pill-shaped control. */
  readonly shape?: 'line' | 'heading' | 'block' | 'pill';
  /** Any CSS length; defaults to the full width of the container. Lines of varying width are what stop a stack of them reading as a barcode. */
  readonly width?: string;
  /** Any CSS length, for the one case the four shapes do not cover (a calendar square, say). */
  readonly height?: string;
}

/**
 * 2026-09-08: a grey shape standing in for content that has not arrived.
 *
 * The reason to draw one rather than leave the space empty is layout: the
 * account dashboard's panels each fetch their own data, and a page that
 * renders nothing until each answer lands jumps every time one does. A
 * skeleton in roughly the right outline holds the space open, so the panel
 * fills in rather than shoving what is below it down the page.
 *
 * Always `aria-hidden`. There is nothing here to read — the sentence in the
 * `Loading` region above it is the whole of what a screen reader should be
 * told, and announcing "blank blank blank" under it would be worse than
 * silence.
 */
export function Skeleton({
  shape = 'line',
  width,
  height,
  className,
  style,
  ...rest
}: SkeletonProps): ReactNode {
  const classes = ['ndn-skeleton', `ndn-skeleton--${shape}`, className].filter(Boolean).join(' ');

  return (
    <span
      className={classes}
      aria-hidden="true"
      style={{ ...(width ? { width } : {}), ...(height ? { height } : {}), ...style }}
      {...rest}
    />
  );
}
