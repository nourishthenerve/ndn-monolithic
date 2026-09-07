// 2026-09-07: the reading estimate. The owner: *"based on the number of
// words, roughly show how long will it take to read the blog."*
//
// The assertions worth having are the two that make the number honest —
// markup is not words, and a short post is never "0 min read" — rather than
// the arithmetic, which is a division.
import { describe, expect, it } from 'vitest';

import { READING_WORDS_PER_MINUTE, readingMinutes, wordCount } from './reading-time.js';

const words = (n: number): string => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

describe('wordCount', () => {
  it('counts words, not characters', () => {
    expect(wordCount('one two three')).toBe(3);
  });

  it('does not count markup as words', () => {
    // A post written in the rich-text editor is HTML. `<p class="lead">` is
    // not two words, and a post gaining a wrapper element must not gain a
    // minute.
    expect(wordCount('<p class="lead">one two three</p>')).toBe(3);
  });

  it('is unbothered by the whitespace a rich-text body carries', () => {
    expect(wordCount('<p>one</p>\n\n  <p>two   three</p>')).toBe(3);
  });

  it('is zero for a body with no text at all', () => {
    expect(wordCount('<img src="x.png">')).toBe(0);
  });
});

describe('readingMinutes', () => {
  it('divides by the reading speed and rounds', () => {
    expect(readingMinutes(words(READING_WORDS_PER_MINUTE * 3))).toBe(3);
  });

  it('never says zero minutes for a post that plainly has words in it', () => {
    // The floor is what the label means — "this is short" — rather than a
    // rounding artefact. "0 min read" reads as a bug.
    expect(readingMinutes('a handful of words')).toBe(1);
  });

  it('is undefined for a post with nothing to read, so no estimate is shown', () => {
    // An image-only post, or a body that never reached the page. The card
    // shows no estimate rather than claiming a minute for nothing — the
    // same choice `publication-date.ts` makes about a missing date.
    expect(readingMinutes('<img src="x.png">')).toBeUndefined();
    expect(readingMinutes(undefined)).toBeUndefined();
    expect(readingMinutes('')).toBeUndefined();
  });

  it('rounds to the nearest minute rather than always up', () => {
    // "Roughly" is the specification. 250 words is closer to one minute
    // than two at 200 wpm, and claiming two would be the same
    // over-precision in the other direction.
    expect(readingMinutes(words(250))).toBe(1);
    expect(readingMinutes(words(350))).toBe(2);
  });
});
