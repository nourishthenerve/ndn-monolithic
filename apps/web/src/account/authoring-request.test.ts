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
});
