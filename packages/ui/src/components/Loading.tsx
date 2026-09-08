import type { ReactNode } from 'react';

import { Spinner } from './Spinner.js';

export interface LoadingProps {
  /** The sentence a screen reader is given, and the one a sighted reader reads beside the spinner. Never empty — an unlabelled live region announces nothing. */
  readonly label: string;
  /** Optional `Skeleton` shapes in the outline of what is being waited for. Decorative, and already `aria-hidden` by the time they get here. */
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * 2026-09-08: one waiting state, shared by every panel that fetches.
 *
 * Until now each of them rendered `<p role="status">Loading…</p>` and
 * nothing else, so signing in gave a page of headings with a word under
 * each, then four separate jumps as the answers arrived. This is the same
 * announcement — same role, same politeness, same sentence — with a spinner
 * that says the wait is progressing and room for skeleton shapes that hold
 * the layout still while it does.
 *
 * `role="status"` and not `aria-live` alone, and that distinction matters
 * beyond politeness here: `tests/pr-env/account-a11y.setup.ts` waits for
 * `getByRole('status')` to reach **zero** before it decides an account page
 * has finished loading. So this must be genuinely transient — rendered while
 * a fetch is in flight and gone once it lands — and a permanent region that
 * merely *looks* like a loading state must never use this component. See
 * `AppointmentCalendar`'s own live region for the other side of that rule.
 */
export function Loading({ label, children, className }: LoadingProps): ReactNode {
  const classes = ['ndn-loading', className].filter(Boolean).join(' ');

  return (
    <div className={classes} role="status" aria-live="polite">
      <p className="ndn-loading-note">
        <Spinner />
        <span>{label}</span>
      </p>
      {children}
    </div>
  );
}
