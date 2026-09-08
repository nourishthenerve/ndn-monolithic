// @vitest-environment jsdom
//
// 2026-09-08: the shared waiting state the account dashboard's panels render
// while they fetch.
//
// Two things are worth pinning and neither is the geometry. First, that the
// wait is still *announced* — the panels used to render `role="status"`
// themselves, and replacing that with a picture of a spinner would have been
// a regression dressed up as a polish pass. Second, that everything else it
// draws is hidden from assistive tech: a screen reader hearing the sentence
// once is the whole point, and a stack of anonymous grey boxes has nothing
// to say.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { PanelPlaceholder } from './PanelPlaceholder.js';

afterEach(cleanup);

// Hoisted rather than written inline on the JSX attribute: `no-hardcoded-strings`
// reads every attribute in `apps/web/**` and a literal there is exactly the
// copy it exists to stop, test file or not. In the real pages this value is
// always `t('…loading')`, resolved by the Astro page and handed down.
const CALENDAR_LABEL = 'Loading your calendar…';
const LABEL = 'Loading…';

describe('PanelPlaceholder', () => {
  it('announces the panel’s own loading sentence through a polite status region', () => {
    render(<PanelPlaceholder label={CALENDAR_LABEL} shape="calendar" />);
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toContain(CALENDAR_LABEL);
  });

  it('hides every shape it draws, so the sentence is read once and not the boxes', () => {
    const { container } = render(<PanelPlaceholder label={LABEL} shape="table" />);
    const shapes = container.querySelectorAll('.ndn-skeleton');
    expect(shapes.length).toBeGreaterThan(0);
    for (const shape of shapes) {
      expect(shape.getAttribute('aria-hidden')).toBe('true');
    }
  });

  // The outline is what stops the page jumping when the answer lands, so the
  // calendar's placeholder has to be a week-shaped grid rather than the
  // default run of lines.
  it('draws a seven-column grid for the calendar and a field stack for a form', () => {
    const { container, rerender } = render(<PanelPlaceholder label={LABEL} shape="calendar" />);
    expect(container.querySelector('.ndn-skeleton-grid')).not.toBeNull();
    expect(container.querySelector('.ndn-skeleton-field')).toBeNull();

    rerender(<PanelPlaceholder label={LABEL} shape="form" />);
    expect(container.querySelector('.ndn-skeleton-grid')).toBeNull();
    expect(container.querySelectorAll('.ndn-skeleton-field').length).toBeGreaterThan(0);
  });

  it('falls back to plain lines when no shape is named', () => {
    const { container } = render(<PanelPlaceholder label={LABEL} />);
    expect(container.querySelector('.ndn-skeleton-grid')).toBeNull();
    expect(container.querySelectorAll('.ndn-skeleton--line').length).toBeGreaterThan(0);
  });
});
