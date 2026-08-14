import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchPublishedBlogPosts } from './content-client.js';

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchPublishedBlogPosts', () => {
  it('requests the content API filtered to the blog keyword and returns the parsed items', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: 'post-1',
            keywords: ['nutrition', 'blog'],
            translations: { en: { title: 'T', body: 'B', excerpt: 'E' } },
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const posts = await fetchPublishedBlogPosts();

    expect(posts).toEqual([
      {
        id: 'post-1',
        keywords: ['nutrition', 'blog'],
        translations: { en: { title: 'T', body: 'B', excerpt: 'E' } },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/content?keyword=blog'));
  });

  it('returns [] on a non-2xx response rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({}, false)));
    expect(await fetchPublishedBlogPosts()).toEqual([]);
  });

  it('returns [] when the network call itself rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('no DataStack in this environment')),
    );
    expect(await fetchPublishedBlogPosts()).toEqual([]);
  });

  it('returns [] when the response body does not match the expected shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ items: [{ oops: true }] })));
    expect(await fetchPublishedBlogPosts()).toEqual([]);
  });
});
