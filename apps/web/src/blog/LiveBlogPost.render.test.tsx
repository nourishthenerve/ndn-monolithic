// @vitest-environment jsdom
//
// 2026-09-14: the owner: *"there are 12 tags which don't appear when I go to
// read the actual/entire blog post."* The post's themes are stored, and the
// listing card shows them, but the article did not. These pin that they now
// do — resolved through the same `themeLabels` map the card uses, so an
// unknown id is dropped rather than shown raw, and a page that passes no map
// shows nothing.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LiveBlogPost } from './LiveBlogPost.js';
import type { LiveBlogPostRecord } from './LiveBlogPost.js';

afterEach(cleanup);

const STRINGS = {
  loading: 'Loading…',
  notFound: 'No such post.',
  error: 'Something went wrong.',
  imageAlt: 'Article lead image',
  publishedOnTemplate: 'Published {date}',
  readingTimeTemplate: '{minutes} min read',
};

const THEME_LABELS = {
  'pain-science': 'Pain Science',
  neurorehabilitation: 'Neurorehabilitation',
};

function record(themes?: readonly string[]): LiveBlogPostRecord {
  return {
    id: 'tagged',
    publishedAt: '2026-09-03T09:00:00.000Z',
    themes,
    translations: { en: { title: 'Tagged post', body: 'A body worth reading.', excerpt: 'x' } },
  };
}

describe('the article shows its themes as tags', () => {
  it('renders a tag for each theme when a label map is given', async () => {
    render(
      <LiveBlogPost
        strings={STRINGS}
        locale="en"
        slug="tagged"
        themeLabels={THEME_LABELS}
        fetchPosts={() => Promise.resolve([record(['pain-science', 'neurorehabilitation'])])}
      />,
    );
    await waitFor(() => expect(screen.getByText('Tagged post')).toBeDefined());
    expect(screen.getByText('Pain Science')).toBeDefined();
    expect(screen.getByText('Neurorehabilitation')).toBeDefined();
  });

  it('skips a theme id the label map does not know, rather than showing the raw id', async () => {
    render(
      <LiveBlogPost
        strings={STRINGS}
        locale="en"
        slug="tagged"
        themeLabels={THEME_LABELS}
        fetchPosts={() => Promise.resolve([record(['pain-science', 'retired-theme'])])}
      />,
    );
    await waitFor(() => expect(screen.getByText('Pain Science')).toBeDefined());
    expect(screen.queryByText('retired-theme')).toBeNull();
  });

  it('shows no tags when the page passes no label map, even if the post has themes', async () => {
    render(
      <LiveBlogPost
        strings={STRINGS}
        locale="en"
        slug="tagged"
        fetchPosts={() => Promise.resolve([record(['pain-science'])])}
      />,
    );
    await waitFor(() => expect(screen.getByText('Tagged post')).toBeDefined());
    expect(screen.queryByText('Pain Science')).toBeNull();
  });
});
