// The two conversions worth testing on their own: keywords, because a
// keyword is a GSI2 partition key and a duplicate silently splits a post
// across two of them; and the local-to-UTC instant, because getting it
// wrong publishes a workshop at the wrong hour.
import { describe, expect, it } from 'vitest';

import {
  buildCreateBlogRequestBody,
  buildCreateWorkshopRequestBody,
  isValidSlug,
  parseKeywords,
  slugify,
  toUtcInstant,
} from './authoring-request.js';

describe('parseKeywords', () => {
  it('splits on commas and newlines, and trims', () => {
    expect(parseKeywords('back pain, mobility\n  posture ')).toEqual([
      'back pain',
      'mobility',
      'posture',
    ]);
  });

  it('drops empty entries rather than storing blank keywords', () => {
    expect(parseKeywords('mobility,,  ,\n')).toEqual(['mobility']);
  });

  // `KEYWORD#<keyword>` is a partition key: two casings of one word would
  // be two partitions holding the same post, and a reader searching one
  // would miss the other.
  it('de-duplicates case-insensitively, keeping the author’s own casing', () => {
    expect(parseKeywords('Mobility, mobility, MOBILITY')).toEqual(['Mobility']);
  });

  it('is empty for an empty box, never [""]', () => {
    expect(parseKeywords('')).toEqual([]);
    expect(parseKeywords('   ')).toEqual([]);
  });
});

describe('isValidSlug', () => {
  it.each(['winter-mobility-tips', 'a', 'post-2026'])('accepts %s', (slug) => {
    expect(isValidSlug(slug)).toBe(true);
  });

  it.each([
    ['leading hyphen', '-nope'],
    ['trailing hyphen', 'nope-'],
    ['double hyphen', 'no--pe'],
    ['uppercase', 'Nope'],
    ['spaces', 'not a slug'],
    ['empty', ''],
  ])('rejects %s', (_label, slug) => {
    expect(isValidSlug(slug)).toBe(false);
  });
});

describe('toUtcInstant', () => {
  it('turns a datetime-local value into a UTC instant', () => {
    const instant = toUtcInstant('2026-09-01T10:00');
    expect(instant).toBeDefined();
    expect(new Date(instant!).toISOString()).toBe(instant);
  });

  // The caller refuses rather than sending `Invalid Date` and collecting
  // a 400 that says nothing useful.
  it('is undefined for anything that does not parse', () => {
    expect(toUtcInstant('')).toBeUndefined();
    expect(toUtcInstant('not a date')).toBeUndefined();
  });
});

describe('buildCreateBlogRequestBody', () => {
  const fields = {
    id: ' winter-tips ',
    title: ' Winter tips ',
    excerpt: ' Stay mobile ',
    body: 'The body, with its own  spacing kept.',
    keywords: 'mobility, Mobility',
    publishNow: false,
  };

  it('trims the short fields, keeps the body verbatim, and folds duplicate keywords', () => {
    const body = buildCreateBlogRequestBody(fields);
    expect(body.id).toBe('winter-tips');
    expect(body.keywords).toEqual(['mobility']);
    expect(body.translations.en).toEqual({
      title: 'Winter tips',
      // Not trimmed: a body's own leading or trailing whitespace is the
      // author's, and collapsing it would edit their writing.
      body: 'The body, with its own  spacing kept.',
      excerpt: 'Stay mobile',
    });
  });

  it('maps the publish checkbox to a status, defaulting to a draft', () => {
    expect(buildCreateBlogRequestBody(fields).status).toBe('draft');
    expect(buildCreateBlogRequestBody({ ...fields, publishNow: true }).status).toBe('published');
  });

  // 2026-09-02: the lead image. Omitted rather than sent empty, the same
  // discipline `capacity` keeps — "no image" and "an image whose key is
  // the empty string" are different facts, and only one of them is true.
  it('carries an uploaded image key, and omits the field entirely without one', () => {
    expect(buildCreateBlogRequestBody({ ...fields, imageKey: 'media/content/id-a.png' }).imageKey).toBe(
      'media/content/id-a.png',
    );
    expect(Object.hasOwn(buildCreateBlogRequestBody(fields), 'imageKey')).toBe(false);
    expect(Object.hasOwn(buildCreateBlogRequestBody({ ...fields, imageKey: '' }), 'imageKey')).toBe(
      false,
    );
  });
});

describe('buildCreateWorkshopRequestBody', () => {
  const fields = {
    id: 'spring-clinic',
    title: 'Spring clinic',
    description: 'An afternoon session.',
    dateTimeLocal: '2026-09-01T10:00',
    capacity: '',
    publishNow: true,
  };

  // D-31 made capacity genuinely optional — "no limit" and "a limit of
  // nothing" must stay different facts.
  it('omits capacity entirely when the box is blank or nonsense', () => {
    expect(buildCreateWorkshopRequestBody(fields, '2026-09-01T09:00:00.000Z')).not.toHaveProperty(
      'capacity',
    );
    expect(
      buildCreateWorkshopRequestBody({ ...fields, capacity: 'lots' }, '2026-09-01T09:00:00.000Z'),
    ).not.toHaveProperty('capacity');
    expect(
      buildCreateWorkshopRequestBody({ ...fields, capacity: '0' }, '2026-09-01T09:00:00.000Z'),
    ).not.toHaveProperty('capacity');
  });

  it('sends a real capacity as a number', () => {
    expect(
      buildCreateWorkshopRequestBody({ ...fields, capacity: ' 12 ' }, '2026-09-01T09:00:00.000Z')
        .capacity,
    ).toBe(12);
  });

  it('carries an uploaded poster key, and omits the field entirely without one', () => {
    expect(
      buildCreateWorkshopRequestBody(
        { ...fields, posterKey: 'media/workshops/id-a.jpg' },
        '2026-09-01T09:00:00.000Z',
      ).posterKey,
    ).toBe('media/workshops/id-a.jpg');
    expect(
      buildCreateWorkshopRequestBody(fields, '2026-09-01T09:00:00.000Z'),
    ).not.toHaveProperty('posterKey');
  });
});

// Added after the first real attempt to post a blog failed: the slug was
// a required, hand-typed field validated against a pattern nobody was
// told, so an ordinary title was rejected client-side and no request was
// ever sent. The title is the thing an author actually has.
describe('slugify', () => {
  it('turns an ordinary title into a usable slug', () => {
    expect(slugify('My first post')).toBe('my-first-post');
    expect(slugify('Winter mobility: 5 tips!')).toBe('winter-mobility-5-tips');
  });

  it('folds accents rather than dropping the letter', () => {
    expect(slugify('Zoë’s guide')).toBe('zoe-s-guide');
  });

  it('never leaves a leading, trailing or doubled hyphen', () => {
    const slug = slugify('  — Hello,   world!! — ');
    expect(slug).toBe('hello-world');
    expect(isValidSlug(slug)).toBe(true);
  });

  it('caps the length without leaving a trailing hyphen', () => {
    const slug = slugify(`${'word '.repeat(40)}`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
    expect(isValidSlug(slug)).toBe(true);
  });

  // The day a second locale ships, a title may have no Latin letters at
  // all. Empty is the honest answer, and the form asks for one by hand —
  // it is never treated as a valid slug.
  it('is empty when there is nothing to slugify, and that is not a valid slug', () => {
    expect(slugify('日本語')).toBe('');
    expect(slugify('!!!')).toBe('');
    expect(isValidSlug('')).toBe(false);
  });

  it('produces something isValidSlug accepts for every ordinary title', () => {
    for (const title of ['A', 'Two words', 'Number 9', 'Trailing space ', 'Mixed CASE Title']) {
      expect(isValidSlug(slugify(title))).toBe(true);
    }
  });
});

