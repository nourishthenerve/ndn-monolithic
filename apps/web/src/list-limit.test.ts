import { describe, expect, it } from 'vitest';

import { takeAtMost } from './list-limit.js';

const items = ['a', 'b', 'c', 'd'];

describe('takeAtMost', () => {
  it("returns everything when no limit is given — the listing pages' behaviour", () => {
    expect(takeAtMost(items)).toEqual(items);
  });

  it("takes the first n when a limit is given — the homepage's behaviour", () => {
    expect(takeAtMost(items, 3)).toEqual(['a', 'b', 'c']);
  });

  it('distinguishes "no limit" from "none": 0 is an empty list, not every item', () => {
    expect(takeAtMost(items, 0)).toEqual([]);
    expect(takeAtMost(items, undefined)).toEqual(items);
  });

  it('is a no-op when there are fewer items than the limit', () => {
    expect(takeAtMost(['a'], 3)).toEqual(['a']);
    expect(takeAtMost([], 3)).toEqual([]);
  });

  it('clamps a negative limit rather than slicing from the end', () => {
    // `items.slice(0, -1)` would return three items — the opposite of what
    // "show at most -1" could ever mean.
    expect(takeAtMost(items, -1)).toEqual([]);
  });

  it('floors a fractional limit and ignores a non-finite one', () => {
    expect(takeAtMost(items, 2.7)).toEqual(['a', 'b']);
    expect(takeAtMost(items, Number.NaN)).toEqual(items);
  });
});
