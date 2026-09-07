// @vitest-environment jsdom
//
// 2026-09-07: the principal's cherry-picking screen. The pure rules
// (`withPlacement`, `moved`) are pinned first because they are where a
// selection is actually built; the rendered tests pin the states the
// principal lands on and the one request this screen can make.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  creditOf,
  moved,
  quoteOf,
  TestimonialCuration,
  withPlacement,
} from './TestimonialCuration.js';
import type { CuratableTestimonial, TestimonialCurationStrings } from './TestimonialCuration.js';

afterEach(cleanup);

const TOKEN = 'test-access-token';
const client = { authorization: () => Promise.resolve(TOKEN) } as never;

const STRINGS: TestimonialCurationStrings = {
  heading: 'Choose what the site shows',
  intro: 'Patients write their own testimonials.',
  loading: 'Loading published testimonials…',
  forbidden: 'Only the principal clinician can choose.',
  unavailable: 'Testimonials are not switched on yet.',
  error: 'The testimonials could not be loaded.',
  empty: 'No patient has published a testimonial yet.',
  uncuratedNotice: 'Nothing has been chosen yet.',
  placementLegend: 'Where this appears',
  placementLanding: 'Landing page and testimonials page',
  placementPage: 'Testimonials page only',
  placementHidden: 'Not shown on the site',
  featuredCountTemplate: '{count} of {max} landing-page places used.',
  featuredFullHint: 'Move one off the landing page to make room.',
  orderHeading: 'Landing page order',
  orderIntro: 'The first is the first quote a visitor reads.',
  moveUp: 'Move {name} up',
  moveDown: 'Move {name} down',
  anonymous: 'Anonymous',
  publishedTemplate: 'published {date}',
  save: 'Save what the site shows',
  saving: 'Saving…',
  saved: 'Saved.',
  saveFailed: 'Your selection could not be saved.',
  unsaved: 'You have unsaved changes.',
};

function item(overrides: Partial<CuratableTestimonial> = {}): CuratableTestimonial {
  return {
    id: 'one',
    quote: { en: 'quote one' },
    attribution: { display: 'firstNameOnly', name: 'Jordan' },
    publishedAt: '2026-08-01T00:00:00.000Z',
    placement: 'hidden',
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as Response;
}

function payload(items: CuratableTestimonial[], curated = true, maxFeatured = 6) {
  return { items, curated, maxFeatured };
}

function renderScreen(overrides: {
  fetchCuration?: (token: string) => Promise<Response>;
  saveCuration?: (token: string, body: unknown) => Promise<Response>;
}) {
  return render(
    <TestimonialCuration
      strings={STRINGS}
      locale="en"
      client={client}
      fetchCuration={overrides.fetchCuration}
      saveCuration={overrides.saveCuration}
    />,
  );
}

describe('withPlacement', () => {
  it('appends a new landing-page pick to the end rather than the front', () => {
    // A newly promoted quote is not silently the most important one — the
    // principal orders them deliberately, below.
    expect(withPlacement({ featured: ['a'], listed: [] }, 'b', 'landing')).toEqual({
      featured: ['a', 'b'],
      listed: [],
    });
  });

  it('moves a testimonial between surfaces rather than into both', () => {
    expect(withPlacement({ featured: ['a'], listed: [] }, 'a', 'page')).toEqual({
      featured: [],
      listed: ['a'],
    });
  });

  it('takes it off the site entirely', () => {
    expect(withPlacement({ featured: [], listed: ['a'] }, 'a', 'hidden')).toEqual({
      featured: [],
      listed: [],
    });
  });

  it('leaves the rest of the landing-page order alone', () => {
    expect(withPlacement({ featured: ['a', 'b', 'c'], listed: [] }, 'b', 'hidden').featured).toEqual(
      ['a', 'c'],
    );
  });
});

describe('moved', () => {
  it('swaps a pick with the one above it', () => {
    expect(moved(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
  });

  it('swaps a pick with the one below it', () => {
    expect(moved(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
  });

  it('does nothing at either end', () => {
    expect(moved(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moved(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });
});

describe('creditOf and quoteOf', () => {
  it('never shows a name on an anonymous testimonial, even if the record carries one', () => {
    expect(creditOf(item({ attribution: { display: 'anonymous', name: 'Jordan' } }), 'Anonymous')).toBe(
      'Anonymous',
    );
  });

  it('falls back to whatever locale was written, so nothing is unpickable', () => {
    expect(quoteOf(item({ quote: { fr: 'French' } }), 'en')).toBe('French');
  });
});

describe('TestimonialCuration', () => {
  it('lists the published testimonials with their current placement', async () => {
    renderScreen({
      fetchCuration: () =>
        Promise.resolve(
          jsonResponse(
            payload([
              item({ id: 'one', placement: 'landing', featuredRank: 0 }),
              item({ id: 'two', quote: { en: 'quote two' }, placement: 'page' }),
            ]),
          ),
        ),
    });

    expect(await screen.findByText('quote one')).toBeTruthy();
    const landing = screen.getByLabelText(STRINGS.placementLanding, {
      selector: '#placement-one-landing',
    }) as HTMLInputElement;
    expect(landing.checked).toBe(true);
  });

  it('says nobody has curated yet, because every row reads "not shown" while all of them are live', async () => {
    renderScreen({
      fetchCuration: () => Promise.resolve(jsonResponse(payload([item()], false))),
    });

    expect(await screen.findByText(STRINGS.uncuratedNotice)).toBeTruthy();
  });

  it('sends the picks the principal made, in the order they made them', async () => {
    const save = vi.fn().mockResolvedValue(jsonResponse(payload([])));
    renderScreen({
      fetchCuration: () =>
        Promise.resolve(
          jsonResponse(
            payload([
              item({ id: 'one' }),
              item({ id: 'two', quote: { en: 'quote two' }, attribution: { display: 'anonymous' } }),
            ]),
          ),
        ),
      saveCuration: save,
    });

    await screen.findByText('quote one');
    fireEvent.click(document.querySelector('#placement-two-landing') as HTMLInputElement);
    fireEvent.click(document.querySelector('#placement-one-page') as HTMLInputElement);
    fireEvent.click(screen.getByText(STRINGS.save));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(TOKEN, { featured: ['two'], listed: ['one'] });
  });

  it('reorders the landing page without touching anything else', async () => {
    const save = vi.fn().mockResolvedValue(jsonResponse(payload([])));
    renderScreen({
      fetchCuration: () =>
        Promise.resolve(
          jsonResponse(
            payload([
              item({ id: 'one', placement: 'landing', featuredRank: 0 }),
              item({
                id: 'two',
                quote: { en: 'quote two' },
                attribution: { display: 'firstNameOnly', name: 'Sam' },
                placement: 'landing',
                featuredRank: 1,
              }),
            ]),
          ),
        ),
      saveCuration: save,
    });

    fireEvent.click(await screen.findByText('Move Sam up'));
    fireEvent.click(screen.getByText(STRINGS.save));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save).toHaveBeenCalledWith(TOKEN, { featured: ['two', 'one'], listed: [] });
  });

  it('stops the principal filling the landing page past its cap', async () => {
    renderScreen({
      fetchCuration: () =>
        Promise.resolve(
          jsonResponse(
            payload(
              [
                item({ id: 'one', placement: 'landing', featuredRank: 0 }),
                item({ id: 'two', quote: { en: 'quote two' } }),
              ],
              true,
              1,
            ),
          ),
        ),
    });

    await screen.findByText('quote two');
    expect((document.querySelector('#placement-two-landing') as HTMLInputElement).disabled).toBe(
      true,
    );
    // The one already on the landing page can still be moved off it.
    expect((document.querySelector('#placement-one-page') as HTMLInputElement).disabled).toBe(
      false,
    );
  });

  it('tells a sub-clinician they may not curate rather than showing an error', async () => {
    renderScreen({ fetchCuration: () => Promise.resolve(jsonResponse({}, 403)) });

    expect(await screen.findByText(STRINGS.forbidden)).toBeTruthy();
  });

  it('distinguishes the feature being switched off from a failure', async () => {
    // 404 is `testimonials.enabled` being off, and retrying cannot help —
    // the same distinction `TestimonialPanel` draws for a patient.
    renderScreen({ fetchCuration: () => Promise.resolve(jsonResponse({}, 404)) });

    expect(await screen.findByText(STRINGS.unavailable)).toBeTruthy();
  });

  it('reports a failed save without discarding what was chosen', async () => {
    renderScreen({
      fetchCuration: () => Promise.resolve(jsonResponse(payload([item()]))),
      saveCuration: () => Promise.resolve(jsonResponse({}, 500)),
    });

    await screen.findByText('quote one');
    fireEvent.click(document.querySelector('#placement-one-landing') as HTMLInputElement);
    fireEvent.click(screen.getByText(STRINGS.save));

    expect(await screen.findByText(STRINGS.saveFailed)).toBeTruthy();
    expect((document.querySelector('#placement-one-landing') as HTMLInputElement).checked).toBe(
      true,
    );
  });

  it('says so when there is nothing to choose from', async () => {
    renderScreen({ fetchCuration: () => Promise.resolve(jsonResponse(payload([]))) });

    expect(await screen.findByText(STRINGS.empty)).toBeTruthy();
  });
});
