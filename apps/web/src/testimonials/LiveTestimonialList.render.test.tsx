// @vitest-environment jsdom
// 2026-09-03: the reconciliation, and the two ways it must not clear the page.
//
// Written after *"it published testimonial by logging in as patient but
// then when I went to testimonial page it's empty."* Two defects met on
// that page: the listing was build-time only, and the client schema still
// required an `id` the API had stopped sending, so even a rebuild would
// have produced nothing. This file covers the first; the schema is
// `testimonial-client.test.ts`'s.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { attributionLabel, LiveTestimonialList, quoteFor } from './LiveTestimonialList.js';
import type { LiveTestimonial } from './LiveTestimonialList.js';

afterEach(cleanup);

const STRINGS = { empty: 'No testimonials yet.', anonymous: 'Anonymous' };

const SEEDED: LiveTestimonial = {
  quote: { en: 'Built at deploy time.' },
  attribution: { display: 'firstNameOnly', name: 'Sam' },
};
const PUBLISHED_SINCE: LiveTestimonial = {
  quote: { en: 'Published five minutes ago.' },
  attribution: { display: 'full', name: 'Jordan' },
};

function renderList(
  initial: readonly LiveTestimonial[],
  fetched: () => Promise<readonly LiveTestimonial[] | undefined>,
) {
  return render(
    <LiveTestimonialList
      strings={STRINGS}
      locale="en"
      initialTestimonials={initial}
      fetchTestimonials={fetched}
    />,
  );
}

describe('LiveTestimonialList', () => {
  it('shows a testimonial published since the last deploy', async () => {
    // The reported bug, in one assertion.
    renderList([], () => Promise.resolve([PUBLISHED_SINCE]));

    expect(await screen.findByText('Published five minutes ago.')).toBeTruthy();
    expect(screen.queryByText(STRINGS.empty)).toBeNull();
  });

  it('paints the build-time list first, so there is no flash of empty', () => {
    // Rendered synchronously, before the fetch can resolve — which is the
    // whole reason the island is seeded rather than fetching on mount.
    renderList([SEEDED], () => new Promise(() => {}));

    expect(screen.getByText('Built at deploy time.')).toBeTruthy();
  });

  it('leaves the seed alone when the API is unreachable', async () => {
    renderList([SEEDED], () => Promise.resolve(undefined));

    // Still there after the fetch has settled. An unreachable API must not
    // be able to empty a page that had content in its HTML.
    await waitFor(() => expect(screen.getByText('Built at deploy time.')).toBeTruthy());
    expect(screen.queryByText(STRINGS.empty)).toBeNull();
  });

  it('does clear the list when the API genuinely returns none', async () => {
    // `undefined` (failed) and `[]` (really none) are different, and only
    // the second should win. A withdrawn testimonial has to actually
    // disappear.
    renderList([SEEDED], () => Promise.resolve([]));

    expect(await screen.findByText(STRINGS.empty)).toBeTruthy();
    expect(screen.queryByText('Built at deploy time.')).toBeNull();
  });

  it('replaces the seed wholesale rather than appending to it', async () => {
    renderList([SEEDED], () => Promise.resolve([PUBLISHED_SINCE]));

    expect(await screen.findByText('Published five minutes ago.')).toBeTruthy();
    expect(screen.queryByText('Built at deploy time.')).toBeNull();
  });

  it('shows the empty state when there is nothing anywhere', async () => {
    renderList([], () => Promise.resolve([]));

    expect(await screen.findByText(STRINGS.empty)).toBeTruthy();
  });
});

describe('attributionLabel', () => {
  it('credits the name the author gave', () => {
    expect(attributionLabel(PUBLISHED_SINCE, STRINGS.anonymous)).toBe('Jordan');
  });

  it('never shows a name on an anonymous testimonial, even if the record carries one', () => {
    // The server strips it too (`toPublicTestimonial`). Repeated here
    // because this is the last place before it reaches a reader.
    expect(
      attributionLabel(
        { quote: { en: 'q' }, attribution: { display: 'anonymous', name: 'Jordan' } },
        STRINGS.anonymous,
      ),
    ).toBe('Anonymous');
  });

  it('falls back to the anonymous label when a named attribution has no name', () => {
    expect(
      attributionLabel({ quote: { en: 'q' }, attribution: { display: 'full' } }, STRINGS.anonymous),
    ).toBe('Anonymous');
  });
});

describe('quoteFor', () => {
  it('prefers this locale', () => {
    expect(quoteFor({ ...SEEDED, quote: { en: 'English', fr: 'French' } }, 'en')).toBe('English');
  });

  it('falls back to whatever was written, rather than hiding the testimonial', () => {
    expect(quoteFor({ ...SEEDED, quote: { fr: 'French' } }, 'en')).toBe('French');
  });

  it('is undefined for a testimonial with no text at all', () => {
    expect(quoteFor({ ...SEEDED, quote: {} }, 'en')).toBeUndefined();
  });
});

describe('the default fetch', () => {
  it('is not called when one is injected', async () => {
    const injected = vi.fn().mockResolvedValue([PUBLISHED_SINCE]);
    renderList([], injected);

    await screen.findByText('Published five minutes ago.');
    expect(injected).toHaveBeenCalledTimes(1);
  });
});
