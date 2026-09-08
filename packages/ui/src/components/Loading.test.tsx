// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { injectPrimitiveStyles } from '../test-support/inject-styles.js';

import { Loading } from './Loading.js';
import { Skeleton } from './Skeleton.js';

afterEach(cleanup);
injectPrimitiveStyles();

describe('Loading', () => {
  it('announces the wait once, in words, through a polite status region', () => {
    render(<Loading label="Loading your calendar…" />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Loading your calendar…');
  });

  it('draws a spinner beside the sentence, and hides it from the announcement', () => {
    const { container } = render(<Loading label="Loading…" />);
    const spinner = container.querySelector('.ndn-spinner');
    expect(spinner).not.toBeNull();
    expect(spinner).toHaveAttribute('aria-hidden', 'true');
  });

  // The skeletons hold the layout open; the label is still the only thing
  // announced, because every shape inside is aria-hidden.
  it('renders skeleton children without adding anything to what is read out', () => {
    const { container } = render(
      <Loading label="Loading…">
        <Skeleton shape="block" />
        <Skeleton />
      </Loading>,
    );
    expect(container.querySelectorAll('.ndn-skeleton')).toHaveLength(2);
    for (const shape of container.querySelectorAll('.ndn-skeleton')) {
      expect(shape).toHaveAttribute('aria-hidden', 'true');
    }
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });
});
