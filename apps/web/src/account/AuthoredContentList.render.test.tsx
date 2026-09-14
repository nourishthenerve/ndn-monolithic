// @vitest-environment jsdom
//
// 2026-09-14: the owner: *"when I save a new blog post … I need to refresh the
// page to update the table below … make it auto reload as soon as I save."*
// The composer and this list are two separate Astro islands, so the save is
// announced on `window` (`CONTENT_SAVED_EVENT`) and the list re-reads on it.
// What matters, and what a pure-function test cannot pin, is that the event
// actually triggers a fresh read — and that a save of the *other* kind does
// not.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AuthoredContentList } from './AuthoredContentList.js';
import type { AuthoredItem } from './AuthoredContentList.js';
import { CONTENT_SAVED_EVENT } from './authoring-submit.js';

afterEach(cleanup);

const STRINGS = {
  heading: 'Your blog posts',
  loading: 'Loading…',
  forbidden: 'Not allowed.',
  error: 'Something went wrong.',
  empty: 'Nothing written yet.',
  titleColumn: 'Title',
  statusColumn: 'Status',
  actionColumn: 'Action',
  publish: 'Publish',
  unpublish: 'Unpublish',
  working: 'Working…',
  actionFailed: 'That did not work.',
  viewLabel: 'View',
};

/** A session client that always hands back a token — the list only calls `authorization`. */
const client = { authorization: () => Promise.resolve('token') } as never;

function item(id: string): AuthoredItem {
  return { id, status: 'draft', translations: { en: { title: `${id} title` } } };
}

/** A `Response` carrying exactly `items`, enough for the list's `.ok`/`.json()` reads. */
function itemsResponse(items: readonly AuthoredItem[]): Response {
  return { ok: true, status: 200, json: () => Promise.resolve({ items }) } as Response;
}

describe('the list re-reads when a save is announced on the same page', () => {
  it('reloads on CONTENT_SAVED_EVENT of its own kind, so a new row appears without a refresh', async () => {
    // First read: one post. Second read (after the save): two.
    const fetchItems = vi
      .fn<(accessToken: string) => Promise<Response>>()
      .mockResolvedValueOnce(itemsResponse([item('first')]))
      .mockResolvedValue(itemsResponse([item('first'), item('second')]));

    render(
      <AuthoredContentList
        strings={STRINGS}
        kind="blog"
        locale="en"
        client={client}
        fetchItems={fetchItems}
      />,
    );

    await waitFor(() => expect(screen.getByText('first title')).toBeDefined());
    expect(screen.queryByText('second title')).toBeNull();

    fireEvent(window, new CustomEvent(CONTENT_SAVED_EVENT, { detail: { kind: 'blog' } }));

    await waitFor(() => expect(screen.getByText('second title')).toBeDefined());
    expect(fetchItems).toHaveBeenCalledTimes(2);
  });

  it('ignores a save of the other kind — a workshop save leaves the blog list alone', async () => {
    const fetchItems = vi
      .fn<(accessToken: string) => Promise<Response>>()
      .mockResolvedValue(itemsResponse([item('first')]));

    render(
      <AuthoredContentList
        strings={STRINGS}
        kind="blog"
        locale="en"
        client={client}
        fetchItems={fetchItems}
      />,
    );

    await waitFor(() => expect(screen.getByText('first title')).toBeDefined());
    expect(fetchItems).toHaveBeenCalledTimes(1);

    fireEvent(window, new CustomEvent(CONTENT_SAVED_EVENT, { detail: { kind: 'workshop' } }));

    // No second read: the effect saw a kind that is not this list's.
    await Promise.resolve();
    expect(fetchItems).toHaveBeenCalledTimes(1);
  });
});
