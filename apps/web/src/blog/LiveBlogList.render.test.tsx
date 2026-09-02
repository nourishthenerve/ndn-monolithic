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

const STRINGS = { empty: 'No posts yet.', readMore: 'Read more' };

function post(id: string, title = `${id} title`): LiveBlogPost {
  return { id, translations: { en: { title, excerpt: `${id} excerpt` } } };
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
