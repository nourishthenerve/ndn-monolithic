// 2026-09-09: the test that makes the colour palette safe rather than merely
// closed.
//
// `rich-text-controls.ts` used to answer the owner's request for colour with
// a refusal, and the reason it gave was a good one: *"a free colour well is
// the one control on a toolbar like this that can produce a page failing the
// contrast gate the rest of the site is held to — grey-on-white body text,
// chosen in good faith by someone who could read it on their own screen."*
//
// The palette in `policy.ts` answers the request instead, and this file is
// what makes that defensible. It walks every ink and every highlight the
// author can reach and asserts each one clears WCAG 2.2 SC 1.4.3's 4.5:1,
// using `packages/ui`'s own contrast function — the same one
// `tokens/color.test.ts` holds the rest of the palette to.
//
// So the guarantee is not "we picked nice colours". It is: **an author
// cannot select an unreadable one, and if someone adds a tenth that is
// unreadable, this fails.**
import { contrastRatio } from '@ndn/ui';
import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_COLORS, TEXT_COLORS } from './policy.js';

/**
 * The two grounds an article is ever painted on.
 *
 * `--ndn-color-surface` is the warm paper the page itself is;
 * `--ndn-color-surface-raised` is the white a card or a panel puts under
 * prose. Both, because a post's body is rendered in each place — the article
 * page and the composer's own preview — and a colour that only passed on one
 * of them would fail wherever the other is used.
 */
const GROUNDS: Readonly<Record<string, string>> = {
  '--ndn-color-surface': '#f8f6f1',
  '--ndn-color-surface-raised': '#ffffff',
};

/** `--ndn-color-text`. Body copy is what sits on a highlight, so this is the ink that pair must clear. */
const BODY_INK = '#232821';

/** WCAG 2.2 SC 1.4.3, normal-size text. Body copy in an article is never "large". */
const MINIMUM_RATIO = 4.5;

describe('the ink an author may choose', () => {
  it('clears 4.5:1 on both grounds a post is rendered on', () => {
    for (const [name, ink] of Object.entries(TEXT_COLORS)) {
      for (const [ground, hex] of Object.entries(GROUNDS)) {
        const ratio = contrastRatio(ink, hex);
        expect(
          ratio,
          `TEXT_COLORS.${name} (${ink}) on ${ground} is ${ratio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(MINIMUM_RATIO);
      }
    }
  });

  it('offers more than one ink, or the palette is a rename of "no colour"', () => {
    expect(Object.keys(TEXT_COLORS).length).toBeGreaterThan(2);
  });
});

describe('the highlight an author may choose', () => {
  it('clears 4.5:1 against the body ink that sits on it', () => {
    for (const [name, tint] of Object.entries(HIGHLIGHT_COLORS)) {
      const ratio = contrastRatio(BODY_INK, tint);
      expect(
        ratio,
        `HIGHLIGHT_COLORS.${name} (${tint}) under body text is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(MINIMUM_RATIO);
    }
  });

  // A highlight is a *background*. Painting one dark enough to need light
  // text would break the one thing the author does not control — the ink of
  // the text they highlighted — so every tint has to stay lighter than the
  // page it sits on is dark.
  it('stays a tint rather than a fill', () => {
    for (const [name, tint] of Object.entries(HIGHLIGHT_COLORS)) {
      const ratio = contrastRatio(BODY_INK, tint);
      expect(ratio, `HIGHLIGHT_COLORS.${name} is too dark to be a highlight`).toBeGreaterThan(7);
    }
  });
});
