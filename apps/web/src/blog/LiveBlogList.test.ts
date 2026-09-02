// 2026-09-02: the listing that makes a published post visible without a
// deploy. The reconciliation itself is exercised in the render test; these
// are the pure decisions it rests on — above all **which link shape a post
// gets**, because getting that wrong sends a reader to a 404.
import { describe, expect, it } from 'vitest';

import { hrefFor, postsForLocale, prerenderedIds } from './LiveBlogList.js';
import type { LiveBlogPost } from './LiveBlogList.js';

function post(id: string, locales: readonly string[] = ['en']): LiveBlogPost {
  return {
    id,
    translations: Object.fromEntries(
      locales.map((locale) => [locale, { title: `${id} title`, excerpt: `${id} excerpt` }]),
    ),
  };
}

describe('hrefFor', () => {
  it('sends a post that was in the build to its own prerendered URL', () => {
    const prerendered = prerenderedIds([post('already-there')]);
    expect(hrefFor('en', 'already-there', prerendered)).toBe('/en/blog/already-there');
  });

  it('sends a post published since the build to the fallback page', () => {
    // It has no file on S3 yet, so its own URL would 404 — this is the
    // whole reason the fallback page exists.
    const prerendered = prerenderedIds([post('already-there')]);
    expect(hrefFor('en', 'brand-new', prerendered)).toBe('/en/blog/post?slug=brand-new');
  });

  it('encodes a slug that needs it', () => {
    expect(hrefFor('en', 'a b&c', prerenderedIds([]))).toBe('/en/blog/post?slug=a%20b%26c');
  });

  it('is locale-prefixed in both shapes', () => {
    const prerendered = prerenderedIds([post('known')]);
    expect(hrefFor('en', 'known', prerendered).startsWith('/en/')).toBe(true);
    expect(hrefFor('en', 'new', prerendered).startsWith('/en/')).toBe(true);
  });
});

describe('prerenderedIds', () => {
  it('is exactly the build-time list — the seed is the only honest source for it', () => {
    expect([...prerenderedIds([post('a'), post('b')])].sort()).toEqual(['a', 'b']);
  });

  it('is empty when the build found nothing, so every post takes the fallback', () => {
    const prerendered = prerenderedIds([]);
    expect(hrefFor('en', 'anything', prerendered)).toBe('/en/blog/post?slug=anything');
  });
});

describe('postsForLocale', () => {
  it('keeps only posts translated into this locale', () => {
    const posts = [post('english', ['en']), post('welsh-only', ['cy'])];
    expect(postsForLocale(posts, 'en').map((entry) => entry.post.id)).toEqual(['english']);
  });

  it('carries the title and excerpt for the locale asked for', () => {
    const entry = postsForLocale([post('one')], 'en')[0];
    expect(entry?.title).toBe('one title');
    expect(entry?.excerpt).toBe('one excerpt');
  });

  it('is empty rather than throwing when nothing matches', () => {
    expect(postsForLocale([post('a', ['cy'])], 'en')).toEqual([]);
  });
});
