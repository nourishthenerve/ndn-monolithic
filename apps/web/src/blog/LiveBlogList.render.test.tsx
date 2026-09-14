// @vitest-environment jsdom
//
// 2026-09-02: the behaviour the owner actually asked for — "I want them to
// go live immediately" — is a *reconciliation*, and reconciliations are
// exactly the thing a pure-function test cannot pin. What matters is what
// is on screen before the fetch resolves, after it resolves, and when it
// never resolves at all.
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LiveBlogList } from './LiveBlogList.js';
import type { LiveBlogPost } from './LiveBlogList.js';

afterEach(cleanup);

const STRINGS = {
  empty: 'No posts yet.',
  readMore: 'Read more',
  newLabel: 'New',
  publishedOnTemplate: 'Published {date}',
  readingTimeTemplate: '{minutes} min read',
};

function post(id: string, title = `${id} title`): LiveBlogPost {
  return {
    id,
    publishedAt: '2026-09-03T09:00:00.000Z',
    translations: { en: { title, excerpt: `${id} excerpt`, body: `${id} body` } },
  };
}

describe('the build-time list is the seed, not a placeholder', () => {
  it('renders the build-time posts immediately, before any fetch resolves', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('built')]}
        // Never resolves — this is the first paint, and it must already
        // have content on it.
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByText('built title')).toBeDefined();
  });

  it('keeps the seed when the content API is unreachable', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('built')]}
        fetchPosts={() => Promise.resolve(undefined)}
      />,
    );
    // The same failure mode the build already chose: no content API means
    // the list you had, not an empty page.
    await waitFor(() => {
      expect(screen.getByText('built title')).toBeDefined();
    });
    expect(screen.queryByText(STRINGS.empty)).toBeNull();
  });

  it('shows a post published since the build, once the fetch lands', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('built')]}
        fetchPosts={() => Promise.resolve([post('built'), post('brand-new')])}
      />,
    );
    expect(await screen.findByText('brand-new title')).toBeDefined();
    expect(screen.getByText('built title')).toBeDefined();
  });

  it('drops a post that has since been unpublished', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('built'), post('withdrawn')]}
        fetchPosts={() => Promise.resolve([post('built')])}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText('withdrawn title')).toBeNull();
    });
    expect(screen.getByText('built title')).toBeDefined();
  });

  it('says so when a build with no posts finds none live either', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[]}
        fetchPosts={() => Promise.resolve([])}
      />,
    );
    expect(await screen.findByText(STRINGS.empty)).toBeDefined();
  });
});

describe('link shapes', () => {
  it('links a built post to its real URL and a new one to the fallback', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('built')]}
        fetchPosts={() => Promise.resolve([post('built'), post('brand-new')])}
      />,
    );
    await screen.findByText('brand-new title');
    const links = screen.getAllByRole('link', { name: 'Read more' });
    const hrefs = links.map((link) => link.getAttribute('href'));
    // The built post keeps the canonical, indexed URL; only the one with
    // no page of its own takes the query-string form.
    expect(hrefs).toContain('/en/blog/built');
    expect(hrefs).toContain('/en/blog/post?slug=brand-new');
  });
});

// 2026-09-06: the homepage shows three posts and links out to the archive
// for the rest. The subtle half is *when* the trim happens — after the
// reconciliation, not to the seed — because a post published since the last
// deploy has to be able to take one of the three places.
describe('the homepage strip', () => {
  const built = [post('a'), post('b'), post('c'), post('d')];

  it('shows only the first `limit` posts', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={built}
        limit={3}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getAllByRole('link', { name: 'Read more' })).toHaveLength(3);
    expect(screen.queryByText('d title')).toBeNull();
  });

  it('still shows a post published since the build, rather than trimming the seed first', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={built}
        limit={3}
        fetchPosts={() => Promise.resolve([post('brand-new'), ...built])}
      />,
    );
    // Trimming the seed to three before reconciling would have left the new
    // post out of the strip entirely — or pushed it to four.
    expect(await screen.findByText('brand-new title')).toBeDefined();
    expect(screen.getAllByRole('link', { name: 'Read more' })).toHaveLength(3);
  });

  it('is unlimited when no limit is given — the /blog listing is unchanged', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={built}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getAllByRole('link', { name: 'Read more' })).toHaveLength(4);
  });

  it('renders post titles at the level the page asks for, so they sit under its section heading', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('a')]}
        headingLevel={3}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByRole('heading', { name: 'a title', level: 3 })).toBeDefined();
  });
});

// 2026-09-13: the owner: *"I want these blogs to be sorted by published
// timestamp in reverse order … the latest blog post to be the first one."*
// The order lives in the DOM, so it is asserted on the DOM: the titles in
// document order are the leftmost/top card first.
describe('newest first', () => {
  const titlesInOrder = (): readonly string[] =>
    screen.getAllByRole('heading').map((heading) => heading.textContent ?? '');

  function atDate(id: string, publishedAt: string): LiveBlogPost {
    return {
      id,
      publishedAt,
      translations: { en: { title: `${id} title`, excerpt: `${id} excerpt`, body: `${id} body` } },
    };
  }

  it('renders the whole /blog listing latest first, whatever order the API returned', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        // Deliberately out of order, as an unspecified API response may be.
        initialPosts={[
          atDate('sep-01', '2026-09-01T09:00:00.000Z'),
          atDate('sep-13', '2026-09-13T09:00:00.000Z'),
          atDate('sep-07', '2026-09-07T09:00:00.000Z'),
        ]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(titlesInOrder()).toEqual(['sep-13 title', 'sep-07 title', 'sep-01 title']);
  });

  it('re-sorts once a newer post reconciles in from the fetch', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[atDate('sep-07', '2026-09-07T09:00:00.000Z')]}
        fetchPosts={() =>
          Promise.resolve([
            atDate('sep-07', '2026-09-07T09:00:00.000Z'),
            atDate('sep-20', '2026-09-20T09:00:00.000Z'),
          ])
        }
      />,
    );
    await screen.findByText('sep-20 title');
    // The just-published post takes the top, not the bottom where it arrived.
    expect(titlesInOrder()).toEqual(['sep-20 title', 'sep-07 title']);
  });

  it('shows the three most recent on the homepage strip, newest leftmost', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        limit={3}
        initialPosts={[
          atDate('sep-01', '2026-09-01T09:00:00.000Z'),
          atDate('sep-13', '2026-09-13T09:00:00.000Z'),
          atDate('sep-05', '2026-09-05T09:00:00.000Z'),
          atDate('sep-09', '2026-09-09T09:00:00.000Z'),
        ]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    // The three latest, in order; the oldest (sep-01) drops off, not whichever
    // three the response happened to list first.
    expect(titlesInOrder()).toEqual(['sep-13 title', 'sep-09 title', 'sep-05 title']);
  });
});

// 2026-09-07: the byline. The owner: *"for blog post and workshops also show
// the date of publication on the thumbnail box at websites landing page as
// well as when someone clicks read more."*
describe('the publication date', () => {
  // Asserted by parts rather than as one string: the exact ordering is
  // `Intl`'s, and `en` renders "September 3, 2026" where `en-GB` would
  // render "3 September 2026". What this test is for is that the site's own
  // formatter ran at all — the month spelled, never a numeric `9/3` that
  // means two different dates on two different machines.
  const metaText = (container: HTMLElement): string =>
    container.querySelector('.ndn-card-meta')?.textContent ?? '';

  it('renders under the title, formatted by the site’s own date formatter', () => {
    const { container } = render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('built')]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );

    expect(metaText(container)).toContain('Published');
    expect(metaText(container)).toContain('September');
    expect(metaText(container)).toContain('2026');
  });

  it('is a real <time>, so a crawler reads the instant and not only the words', () => {
    const { container } = render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[post('built')]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );

    expect(container.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-09-03T09:00:00.000Z',
    );
  });

  it('falls back to created_at for a post written before publishedAt existed', () => {
    // Every post live today is this shape. The fallback is the normal
    // path, not an edge case.
    const { container } = render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[
          {
            id: 'legacy',
            created_at: '2026-07-04T09:00:00.000Z',
            translations: { en: { title: 'legacy title', excerpt: 'legacy excerpt' } },
          },
        ]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );

    expect(metaText(container)).toContain('July');
  });

  it('renders the card with no date rather than a broken one when the record has neither', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[
          { id: 'dateless', translations: { en: { title: 'dateless title', excerpt: 'x' } } },
        ]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );

    expect(screen.getByText('dateless title')).toBeDefined();
    expect(screen.queryByText(/Published/)).toBeNull();
  });
});

// 2026-09-07: the reading estimate. The owner: *"based on the number of
// words, roughly show how long will it take to read the blog on blog card as
// well as on the blog page itself."*
describe('the reading estimate', () => {
  const meta = (container: HTMLElement): string =>
    container.querySelector('.ndn-card-meta')?.textContent ?? '';

  function withBody(body: string | undefined): LiveBlogPost {
    return {
      id: 'sized',
      publishedAt: '2026-09-03T09:00:00.000Z',
      translations: { en: { title: 'sized title', excerpt: 'sized excerpt', body } },
    };
  }

  it('shares the byline line with the publication date', () => {
    // Both are what a reader weighs before clicking, and two stacked lines
    // of grey would crowd a card that is mostly excerpt.
    const { container } = render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[withBody(new Array(400).fill('word').join(' '))]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );

    expect(meta(container)).toContain('Published');
    expect(meta(container)).toContain('2 min read');
  });

  it('is counted from the post’s words, not its markup', () => {
    const { container } = render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[withBody(`<p class="lead">${new Array(600).fill('word').join(' ')}</p>`)]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );

    expect(meta(container)).toContain('3 min read');
  });

  it('leaves the date alone on a post with nothing to estimate from', () => {
    const { container } = render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[withBody(undefined)]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );

    expect(meta(container)).toContain('Published');
    expect(meta(container)).not.toContain('min read');
  });

  it('appears on a post reconciled after the build, which the build never sized', () => {
    // The whole reason the estimate is computed in the island rather than
    // handed to it: a post published since the last deploy arrives from the
    // API and has to be measured here.
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[]}
        fetchPosts={() =>
          Promise.resolve([withBody(new Array(1000).fill('word').join(' '))])
        }
      />,
    );

    return screen.findByText(/5 min read/);
  });
});

describe('a post shows its themes as tags', () => {
  const THEME_LABELS = {
    'pain-science': 'Pain Science',
    neurorehabilitation: 'Neurorehabilitation',
  };

  function tagged(themes: readonly string[]): LiveBlogPost {
    return {
      id: 'tagged',
      publishedAt: '2026-09-03T09:00:00.000Z',
      themes,
      translations: { en: { title: 'Tagged post', excerpt: 'excerpt', body: 'body' } },
    };
  }

  it('renders a tag for each theme when a label map is given', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        themeLabels={THEME_LABELS}
        initialPosts={[tagged(['pain-science', 'neurorehabilitation'])]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByText('Pain Science')).toBeDefined();
    expect(screen.getByText('Neurorehabilitation')).toBeDefined();
  });

  it('shows no tags when the page passes no label map, even if the post has themes', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        initialPosts={[tagged(['pain-science'])]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.queryByText('Pain Science')).toBeNull();
  });

  it('skips a theme id the label map does not know, rather than showing the raw id', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        themeLabels={THEME_LABELS}
        initialPosts={[tagged(['pain-science', 'retired-theme'])]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByText('Pain Science')).toBeDefined();
    expect(screen.queryByText('retired-theme')).toBeNull();
  });
});

describe('a recently published post is marked "New"', () => {
  // A fixed clock so the 30-day window is exact rather than the test machine's.
  const now = () => Date.parse('2026-09-14T00:00:00.000Z');

  function dated(id: string, publishedAt: string): LiveBlogPost {
    return {
      id,
      publishedAt,
      translations: { en: { title: `${id} title`, excerpt: 'x', body: 'body' } },
    };
  }

  it('shows the marker on a post published within the last 30 days', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        now={now}
        initialPosts={[dated('fresh', '2026-09-10T09:00:00.000Z')]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    // Appears after mount — the marker is decided against the reader's clock,
    // not at render — so it is awaited rather than asserted synchronously.
    expect(await screen.findByText('New')).toBeDefined();
  });

  it('does not show the marker on a post older than 30 days', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        now={now}
        initialPosts={[dated('old', '2026-07-01T09:00:00.000Z')]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    // The card is on screen…
    expect(await screen.findByText('old title')).toBeDefined();
    // …and it carries no marker.
    expect(screen.queryByText('New')).toBeNull();
  });

  it('marks only the posts that are actually recent when a list mixes both', async () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        now={now}
        initialPosts={[
          dated('fresh', '2026-09-12T09:00:00.000Z'),
          dated('old', '2026-01-01T09:00:00.000Z'),
        ]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    await screen.findByText('fresh title');
    // One marker across the two cards.
    expect(screen.getAllByText('New')).toHaveLength(1);
  });
});

describe('a topic page shows only the posts carrying that theme', () => {
  function themed(id: string, themes: readonly string[]): LiveBlogPost {
    return {
      id,
      publishedAt: '2026-09-03T09:00:00.000Z',
      themes,
      translations: { en: { title: `${id} title`, excerpt: 'x', body: 'body' } },
    };
  }

  it('keeps the posts that include the filtered theme and drops the rest', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        themeFilter="pain-science"
        initialPosts={[
          themed('has-it', ['pain-science', 'womens-health']),
          themed('also-has-it', ['pain-science']),
          themed('not-tagged', ['neurorehabilitation']),
          themed('no-themes', []),
        ]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByText('has-it title')).toBeDefined();
    expect(screen.getByText('also-has-it title')).toBeDefined();
    expect(screen.queryByText('not-tagged title')).toBeNull();
    expect(screen.queryByText('no-themes title')).toBeNull();
  });

  it('shows the empty message when no post carries the filtered theme', () => {
    render(
      <LiveBlogList
        strings={STRINGS}
        locale="en"
        themeFilter="lifestyle-medicine"
        initialPosts={[themed('other', ['pain-science'])]}
        fetchPosts={() => new Promise(() => {})}
      />,
    );
    expect(screen.getByText(STRINGS.empty)).toBeDefined();
    expect(screen.queryByText('other title')).toBeNull();
  });
});
