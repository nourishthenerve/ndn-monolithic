import { describe, expect, it } from 'vitest';

import { nestedHeadingLevel } from './heading-level.js';

describe('nestedHeadingLevel', () => {
  it('goes one level deeper', () => {
    expect(nestedHeadingLevel(2)).toBe(3);
    expect(nestedHeadingLevel(3)).toBe(4);
  });

  it('clamps at 6 rather than producing an element that does not exist', () => {
    // HTML has no <h7>; a heading that silently vanished would be worse than
    // one merely deeper than ideal.
    expect(nestedHeadingLevel(6)).toBe(6);
  });
});
