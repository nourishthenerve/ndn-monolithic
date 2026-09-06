// 2026-09-06: what a submit says when it lands, shared by both composers.
//
// Lifted verbatim out of `AuthoringPanel.tsx` when that component was split
// into a blog page and a workshop page. It is a component rather than a
// helper on each side because it is markup with roles on it — `role="alert"`
// for the four failures and `role="status"` for the one success — and two
// copies of that is two chances for one of them to be announced and the
// other not.
import type { ReactNode } from 'react';

import type { SubmitStatus } from './authoring-submit.js';

export interface AuthoringMessageStrings {
  readonly successMessage: string;
  /** 2026-09-01: when a saved item actually reaches the public site — see below. */
  readonly publishDelayNotice: string;
  readonly conflictError: string;
  readonly invalidError: string;
  readonly forbidden: string;
  readonly error: string;
}

export function AuthoringMessages({
  status,
  strings,
}: {
  readonly status: SubmitStatus;
  readonly strings: AuthoringMessageStrings;
}): ReactNode {
  return (
    <>
      {status === 'forbidden' && <p role="alert">{strings.forbidden}</p>}
      {status === 'conflict' && <p role="alert">{strings.conflictError}</p>}
      {status === 'invalid' && <p role="alert">{strings.invalidError}</p>}
      {status === 'error' && <p role="alert">{strings.error}</p>}
      {status === 'success' && (
        <p role="status">
          {strings.successMessage}{' '}
          {/* 2026-09-01: the site is statically generated (ADR-0017), so a
              saved post is in the database but not yet on the public page —
              it appears at the next deploy. Saying so here is the difference
              between "it saved" and "it worked", which is what the owner was
              reading it as when nothing showed up under the blog tab. */}
          {strings.publishDelayNotice}
        </p>
      )}
    </>
  );
}
