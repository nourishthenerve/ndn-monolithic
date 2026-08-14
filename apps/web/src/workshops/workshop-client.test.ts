import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPublishedWorkshops } from './workshop-client.js';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPublishedWorkshops', () => {
  it('requests the workshops endpoint and returns the parsed items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'workshop-1',
            dateTimeUtc: '2026-07-01T10:00:00.000Z',
            capacity: 20,
            priceMinorUnits: 2500,
            details: { en: { title: 'Balance & Falls Prevention', description: 'A workshop.' } },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const workshops = await fetchPublishedWorkshops();

    expect(workshops).toEqual([
      {
        id: 'workshop-1',
        dateTimeUtc: '2026-07-01T10:00:00.000Z',
        capacity: 20,
        priceMinorUnits: 2500,
        details: { en: { title: 'Balance & Falls Prevention', description: 'A workshop.' } },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/workshops'));
  });

  it('returns [] on a non-2xx response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false)));
    expect(await fetchPublishedWorkshops()).toEqual([]);
  });

  it('returns [] when the network call itself rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('no DataStack in this environment')),
    );
    expect(await fetchPublishedWorkshops()).toEqual([]);
  });

  it('returns [] when the response body does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [{ oops: true }] })));
    expect(await fetchPublishedWorkshops()).toEqual([]);
  });
});
