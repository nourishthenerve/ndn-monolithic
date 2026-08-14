import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPublishedTestimonials } from './testimonial-client.js';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPublishedTestimonials', () => {
  it('requests the shared content API and returns the parsed items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'testimonial-1',
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
        id: 'testimonial-1',
        quote: { en: 'This service changed my recovery.' },
        attribution: { display: 'firstNameOnly', name: 'Jordan' },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/testimonials'));
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
