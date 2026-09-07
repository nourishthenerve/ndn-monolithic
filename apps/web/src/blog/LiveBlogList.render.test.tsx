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
  publishedOnTemplate: 'Published {date}',
};

function post(id: string, title = `${id} title`): LiveBlogPost {
  return {
    id,
    publishedAt: '2026-09-03T09:00:00.000Z',
    translations: { en: { title, excerpt: `${id} excerpt` } },
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
