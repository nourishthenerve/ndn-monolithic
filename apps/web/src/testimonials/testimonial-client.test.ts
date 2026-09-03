import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPublishedTestimonials } from './testimonial-client.js';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPublishedTestimonials', () => {
  // 2026-09-03: the fixture is the API's **actual** response body, copied
  // from a live `curl`. It carried an `id` before, which the endpoint had
  // stopped returning — so the schema kept requiring a field that was
  // never sent, every real response failed to parse, and this test passed
  // the whole time by asserting against a shape only it produced.
  it('requests the shared content API and returns the parsed items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            quote: { en: 'This service changed my recovery.' },
            attribution: { display: 'firstNameOnly', name: 'Jordan' },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const testimonials = await fetchPublishedTestimonials();

    expect(testimonials).toEqual([
      {
        quote: { en: 'This service changed my recovery.' },
        attribution: { display: 'firstNameOnly', name: 'Jordan' },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/testimonials'));
  });

  it('parses the exact body the live endpoint returns', async () => {
    // Verbatim from production on 2026-09-03. A fixture written by hand
    // agrees with whatever the person writing it believed; this one
    // agrees with the server.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          items: [{ quote: { en: 'good work' }, attribution: { display: 'full', name: 'hi' } }],
        }),
      ),
    );

    expect(await fetchPublishedTestimonials()).toHaveLength(1);
  });

  it('ignores an id if one is ever sent, rather than refusing the whole list', async () => {
    // Zod strips unknown keys by default. Asserted so a field *added* to
    // the projection later cannot empty the public page the way a field
    // removed from it just did.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          items: [
            { id: 'x', status: 'published', quote: { en: 'q' }, attribution: { display: 'anonymous' } },
          ],
        }),
      ),
    );

    expect(await fetchPublishedTestimonials()).toEqual([
      { quote: { en: 'q' }, attribution: { display: 'anonymous' } },
    ]);
  });

  it('returns [] on a non-2xx response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false)));
    expect(await fetchPublishedTestimonials()).toEqual([]);
  });

  it('returns [] when the network call itself rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('no DataStack in this environment')),
    );
    expect(await fetchPublishedTestimonials()).toEqual([]);
  });

  it('returns [] when the response body does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [{ oops: true }] })));
    expect(await fetchPublishedTestimonials()).toEqual([]);
  });
});
