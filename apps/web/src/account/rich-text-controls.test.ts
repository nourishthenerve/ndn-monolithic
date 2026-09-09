// 2026-09-06: the toolbar as data, checked exhaustively.
//
// The component around it is a `contenteditable` island with no jsdom pattern
// to drive end to end — which is exactly why the table is a separate module.
// What can be proved here is the class of mistake a twenty-nine-entry list
// invites: a duplicate id (two buttons sharing a roving-tabindex position), a
// control with no label (an unnamed button on a toolbar of glyphs), or a
// command whose output `rich-text/policy.ts` would then throw away.
import { colorSchemeCssVariables } from '@ndn/ui';
import { describe, expect, it } from 'vitest';

import { ALLOWED_TAGS, HIGHLIGHT_COLORS, TEXT_COLORS } from '../rich-text/policy.js';
import { isSafeRichText } from '../rich-text/render.js';
import { proseStylesCss } from '../rich-text/styles.js';

import {
  HIGHLIGHT_COLOR,
  HIGHLIGHT_SWATCHES,
  REMOVE_HIGHLIGHT_VALUE,
  RICH_TEXT_CONTROLS,
  RICH_TEXT_GROUPS,
  TABLE_HTML,
  TEXT_COLOR_SWATCHES,
} from './rich-text-controls.js';

describe('every control', () => {
  it('has an id of its own', () => {
    const ids = RICH_TEXT_CONTROLS.map((control) => control.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has a catalogue key for its accessible name', () => {
    // The visible mark is a glyph. Without this the button has no name at
    // all — for a screen reader, and for anyone hovering to find out what it
    // does.
    for (const control of RICH_TEXT_CONTROLS) {
      expect(control.labelKey, `${control.id} has no label`).toMatch(/^richText\./);
    }
  });

  it('has something to draw, and only one of the two ways to draw it', () => {
    for (const control of RICH_TEXT_CONTROLS) {
      const hasGlyph = Boolean(control.glyph);
      const hasIcon = Boolean(control.iconPath);
      expect(hasGlyph || hasIcon, `${control.id} renders nothing`).toBe(true);
      expect(hasGlyph && hasIcon, `${control.id} renders twice`).toBe(false);
    }
  });

  it('either issues a command or names an action, never neither', () => {
    // A control with neither is a button that does nothing when pressed.
    for (const control of RICH_TEXT_CONTROLS) {
      expect(
        Boolean(control.command) || Boolean(control.action),
        `${control.id} does nothing`,
      ).toBe(true);
    }
  });

  it('belongs to a group the toolbar renders', () => {
    for (const control of RICH_TEXT_CONTROLS) {
      expect(RICH_TEXT_GROUPS).toContain(control.group);
    }
  });
});

describe('the block controls', () => {
  it('name a tag the policy actually keeps', () => {
    // `formatBlock` into a tag the sanitiser then unwraps would be a button
    // whose effect disappears the moment the author stops typing.
    for (const control of RICH_TEXT_CONTROLS) {
      if (control.blockTag) {
        expect(ALLOWED_TAGS.has(control.blockTag), `${control.blockTag} is not allowed`).toBe(true);
      }
    }
  });

  it('pass the tag in angle brackets, which Firefox requires', () => {
    // Without them `formatBlock` silently does nothing in Gecko.
    for (const control of RICH_TEXT_CONTROLS) {
      if (control.command === 'formatBlock') {
        expect(control.value, `${control.id} would be a no-op in Firefox`).toMatch(/^<[a-z0-9]+>$/);
      }
    }
  });

  it('covers the three heading levels the stylesheet renders, and no more', () => {
    const headings = RICH_TEXT_CONTROLS.filter((control) => control.blockTag?.startsWith('h')).map(
      (control) => control.blockTag,
    );
    expect(headings).toEqual(['h2', 'h3', 'h4']);
  });
});

describe('what the insert controls produce', () => {
  it('inserts a table the validator will accept', () => {
    // Built by hand as a string, so nothing else checks it: a typo here would
    // publish a table that `renderableRichText` then refuses, silently
    // flattening the whole post to plain text.
    expect(isSafeRichText(TABLE_HTML)).toBe(true);
  });

  it('uses a fixed highlight rather than a colour the author picks', () => {
    // 2026-09-09: colour arrived, and the guarantee changed shape rather
    // than going away. What must stay impossible is a *free* colour well —
    // a control that hands `execCommand` a value the author typed. Both
    // colour controls are `action`s opening a panel of fixed swatches, so
    // neither carries a `command` at all.
    expect(HIGHLIGHT_COLOR).toMatch(/^#[0-9a-f]{6}$/);
    const colourControls = RICH_TEXT_CONTROLS.filter((control) =>
      ['foreColor', 'backColor', 'hiliteColor'].includes(control.command ?? ''),
    );
    expect(colourControls).toEqual([]);
  });

  // The one literal colour left in apps/web, because execCommand cannot be
  // handed a custom property (see HIGHLIGHT_COLOR's own note). If the palette
  // moves and this does not, an author's highlight changes colour between the
  // editor and the published post — silently, and only for text already
  // written.
  it('matches the accent tint <mark> is published with', () => {
    expect(HIGHLIGHT_COLOR).toBe(colorSchemeCssVariables('light')['--ndn-color-accent-soft']);
    expect(proseStylesCss).toContain('background-color: var(--ndn-color-accent-soft)');
  });
});

// 2026-09-09: the palette is a boundary (`policy.ts`) and the swatches are a
// view of it. These assert the direction of that dependency holds, because
// the failure it prevents is invisible: a swatch the policy does not know
// paints a colour the sanitiser strips on the next keystroke, so the button
// works, the text changes, and the change vanishes a moment later.
describe('the colour swatches', () => {
  it('offer exactly what the policy admits, and nothing else', () => {
    expect(TEXT_COLOR_SWATCHES.map((swatch) => swatch.hex)).toEqual(Object.values(TEXT_COLORS));
    expect(HIGHLIGHT_SWATCHES.map((swatch) => swatch.hex)).toEqual(Object.values(HIGHLIGHT_COLORS));
  });

  it('names every swatch from the catalogue rather than by its hex', () => {
    for (const swatch of [...TEXT_COLOR_SWATCHES, ...HIGHLIGHT_SWATCHES]) {
      expect(swatch.labelKey).toBe(`richText.color.${swatch.id}`);
      expect(swatch.hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  // "Remove highlight" works by handing the engine a value the policy
  // refuses, so the attribute is dropped and the span unwrapped. If this
  // ever became a palette entry the highlight would persist instead.
  it('removes a highlight with a value the policy will not keep', () => {
    expect(Object.values(HIGHLIGHT_COLORS)).not.toContain(REMOVE_HIGHLIGHT_VALUE);
  });

  it('gives each colour control a panel rather than a command', () => {
    for (const id of ['textColor', 'highlight']) {
      const control = RICH_TEXT_CONTROLS.find((entry) => entry.id === id);
      expect(control, `no "${id}" control`).toBeDefined();
      expect(control?.command).toBeUndefined();
      expect(control?.action).toBe(id);
    }
  });
});
