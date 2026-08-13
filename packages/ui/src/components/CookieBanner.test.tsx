// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { injectPrimitiveStyles } from '../test-support/inject-styles.js';

import { CookieBanner } from './CookieBanner.js';
import { interactiveClassName } from './primitive-styles.js';

afterEach(cleanup);
injectPrimitiveStyles();

function renderBanner(extraProps: Record<string, unknown> = {}) {
  return render(
    <CookieBanner
      label="Cookie consent"
      message="We use essential cookies to run this site, and optional analytics cookies."
      acceptLabel="Accept all"
      rejectLabel="Reject non-essential"
      policyLabel="Read our cookie policy"
      policyHref="/en/legal/cookies"
      {...extraProps}
    />,
  );
}

describe('CookieBanner', () => {
  it('renders as a labelled landmark region, not an unlabelled div', () => {
    const { getByRole } = renderBanner();
    expect(getByRole('region', { name: 'Cookie consent' })).toBeInTheDocument();
  });

  it('links to the cookie policy page passed in by the caller', () => {
    const { getByRole } = renderBanner();
    expect(getByRole('link', { name: 'Read our cookie policy' })).toHaveAttribute(
      'href',
      '/en/legal/cookies',
    );
  });

  it('marks its accept/reject buttons with the data hook the production wiring script queries', () => {
    const { getByRole } = renderBanner();
    expect(getByRole('button', { name: 'Accept all' })).toHaveAttribute(
      'data-cookie-action',
      'accept',
    );
    expect(getByRole('button', { name: 'Reject non-essential' })).toHaveAttribute(
      'data-cookie-action',
      'reject',
    );
  });

  it('both actions carry the shared interactive/tap-target class', () => {
    const { getByRole } = renderBanner();
    expect(getByRole('button', { name: 'Accept all' })).toHaveClass(interactiveClassName);
    expect(getByRole('button', { name: 'Reject non-essential' })).toHaveClass(
      interactiveClassName,
    );
  });

  it('forwards arbitrary HTML attributes (e.g. id, hidden) to the root region, same as Card/Button', () => {
    const { getByRole } = renderBanner({ id: 'ndn-cookie-consent', hidden: true });
    // testing-library excludes elements with the native `hidden` attribute
    // from role queries by default — `{ hidden: true }` here opts back in,
    // proving the attribute really reached the DOM node rather than
    // asserting anything about accessibility-tree exposure.
    const region = getByRole('region', { hidden: true });
    expect(region).toHaveAttribute('id', 'ndn-cookie-consent');
    expect(region).toHaveAttribute('hidden');
  });
});
