import type { HTMLAttributes, ReactNode } from 'react';

import { Button } from './Button.js';
import { Link } from './Link.js';

export interface CookieBannerProps extends HTMLAttributes<HTMLDivElement> {
  /** Accessible name for the banner's landmark region — this package has no i18n dependency, so every string is a caller-supplied prop, never a literal here. */
  readonly label: string;
  readonly message: ReactNode;
  readonly acceptLabel: ReactNode;
  readonly rejectLabel: ReactNode;
  readonly policyLabel: ReactNode;
  readonly policyHref: string;
}

/**
 * Presentational only, and rendered with zero framework runtime shipped
 * (ADR-0017: zero JS by default) — `data-cookie-action="accept"/"reject"`
 * on the two buttons is the real production hook. apps/web's BaseLayout
 * wires them up with a plain, externally-bundled `<script>` calling
 * scripts/consent.ts, rather than hydrating this component via a
 * `client:*` directive: Astro's island runtime needs its own inline
 * bootstrap `<script>`, which the CloudFront CSP's `script-src` (falls
 * back to `default-src 'self'`, no `'unsafe-inline'`) silently blocks —
 * confirmed by inspecting a real `astro build` output before choosing
 * this shape instead.
 */
export function CookieBanner({
  label,
  message,
  acceptLabel,
  rejectLabel,
  policyLabel,
  policyHref,
  className,
  ...rest
}: CookieBannerProps): ReactNode {
  const classes = ['ndn-cookie-banner', className].filter(Boolean).join(' ');

  return (
    <div className={classes} role="region" aria-label={label} {...rest}>
      <p className="ndn-cookie-banner-message">{message}</p>
      <div className="ndn-cookie-banner-actions">
        <Link href={policyHref}>{policyLabel}</Link>
        <Button variant="secondary" data-cookie-action="reject">
          {rejectLabel}
        </Button>
        <Button data-cookie-action="accept">{acceptLabel}</Button>
      </div>
    </div>
  );
}
