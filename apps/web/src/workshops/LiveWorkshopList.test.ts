// 2026-09-02: the workshops half. Same decisions as `LiveBlogList`'s own
// suite — above all which link shape a workshop gets, since the wrong one
// is a 404 — plus the one thing workshops have that posts do not: an alt
// text that has to be interpolated in the browser.
import { describe, expect, it } from 'vitest';

import {
  hrefFor,
  posterAltFor,
  prerenderedIds,
  workshopsForLocale,
} from './LiveWorkshopList.js';
import type { LiveWorkshop } from './LiveWorkshopList.js';

function workshop(id: string, locales: readonly string[] = ['en']): LiveWorkshop {
  return {
    id,
    dateTimeUtc: '2026-10-01T10:00:00.000Z',
    details: Object.fromEntries(
      locales.map((locale) => [locale, { title: `${id} title`, description: `${id} description` }]),
    ),
  };
}

describe('hrefFor', () => {
  it('sends a workshop that was in the build to its own prerendered URL', () => {
    expect(hrefFor('en', 'built', prerenderedIds([workshop('built')]))).toBe(
      '/en/workshops/built',
    );
  });

  it('sends one published since the build to the fallback page', () => {
    expect(hrefFor('en', 'new', prerenderedIds([workshop('built')]))).toBe(
      '/en/workshops/workshop?slug=new',
    );
  });

  it('encodes a slug that needs it', () => {
    expect(hrefFor('en', 'a b&c', prerenderedIds([]))).toBe(
      '/en/workshops/workshop?slug=a%20b%26c',
    );
  });
});

describe('posterAltFor', () => {
  // `t()` runs at build time in the page, so a workshop the build never
  // saw cannot have had its alt text interpolated there — the template
  // comes through with the placeholder intact and is filled here.
  it('substitutes the title into the catalogue template', () => {
    expect(posterAltFor('Poster for {title}', 'Balance and mobility')).toBe(
      'Poster for Balance and mobility',
    );
  });

  it('leaves a template with no placeholder alone', () => {
    expect(posterAltFor('Workshop poster', 'Anything')).toBe('Workshop poster');
  });
});

describe('workshopsForLocale', () => {
  it('keeps only workshops with detail for this locale', () => {
    const items = [workshop('english', ['en']), workshop('welsh-only', ['cy'])];
    expect(workshopsForLocale(items, 'en').map((entry) => entry.workshop.id)).toEqual(['english']);
  });

  it('carries the title and description for the locale asked for', () => {
    const entry = workshopsForLocale([workshop('one')], 'en')[0];
    expect(entry?.title).toBe('one title');
    expect(entry?.description).toBe('one description');
  });
});
