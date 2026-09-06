// 2026-09-06: two stylesheets held as strings, so they can be read as text —
// the reason `calendar-styles.ts` and `packages/ui`'s `primitiveStylesCss`
// are strings too.
//
// The check that earns its place here is coverage: an author can produce any
// element on `policy.ts`'s list, and one with no rule renders as whatever the
// browser's default happens to be. A `<blockquote>` with no styling is an
// indented paragraph nobody can tell is a quote.
import { describe, expect, it } from 'vitest';

import { ALLOWED_TAGS } from './policy.js';
import { proseStylesCss, richTextEditorStylesCss } from './styles.js';

/**
 * Elements that carry no look of their own.
 *
 * `br` and `tbody` have nothing to style; `strong`, `em`, `u`, `s`, `sub`,
 * `sup` and the table sections are already correct by user-agent default, and
 * restating them would be worse than inheriting the reader's own settings.
 */
const NEEDS_NO_RULE = new Set([
  'br',
  'strong',
  'em',
  'u',
  's',
  'sub',
  'sup',
  'thead',
  'tbody',
  'tr',
]);

describe('proseStylesCss', () => {
  it('styles every element a post is allowed to contain', () => {
    for (const tag of ALLOWED_TAGS) {
      if (NEEDS_NO_RULE.has(tag)) {
        continue;
      }
      expect(
        proseStylesCss,
        `no .ndn-prose rule for <${tag}> — it would render as a browser default`,
      ).toContain(`.ndn-prose ${tag}`);
    }
  });

  it('scopes every rule under the one class, never as a bare element selector', () => {
    // These rules meet markup nobody reviewed, on pages that also render the
    // site's own navigation. A bare `h2` rule here would restyle every
    // heading on every page that includes this file.
    const selectors = proseStylesCss
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((block) => block.split('{')[0] ?? '')
      .flatMap((selector) => selector.split(','))
      .map((selector) => selector.trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) {
      expect(selector.startsWith('.ndn-prose'), `unscoped selector: ${selector}`).toBe(true);
    }
  });

  it('keeps a code block and a table inside their own scroll box', () => {
    // Neither has a width anyone planned for: an author's table has as many
    // columns as they typed, and a code line is as long as it is. Without
    // this they widen the page instead of themselves.
    expect(proseStylesCss).toContain('overflow-x: auto');
  });

  it('carries no backtick, which would end the template literal it lives in', () => {
    expect(proseStylesCss).not.toContain('`');
    expect(richTextEditorStylesCss).not.toContain('`');
  });
});

describe('richTextEditorStylesCss', () => {
  it('keeps a toggled control looking toggled while the pointer is over it', () => {
    // Without the hover pair, a pressed Bold button loses its pressed look
    // the moment the mouse is on it — which is exactly when it is read.
    expect(richTextEditorStylesCss).toContain(".ndn-rte-button[aria-pressed='true']:hover");
  });

  it('gives the toolbar buttons a visible focus ring of their own', () => {
    // They are plain `<button>`s, not `packages/ui`'s `Button`, so they
    // inherit none of `.ndn-interactive`'s focus styling.
    expect(richTextEditorStylesCss).toContain('.ndn-rte-button:focus-visible');
    expect(richTextEditorStylesCss).toContain('.ndn-rte-surface:focus-visible');
  });

  it('is separate from the prose stylesheet, which reader-facing pages load alone', () => {
    // A public blog page has no toolbar on it; shipping the editor's CSS to
    // every signed-out reader would be dead weight on the one page this
    // site's Core Web Vitals budget actually watches.
    expect(richTextEditorStylesCss).not.toContain('.ndn-prose p');
    expect(proseStylesCss).not.toContain('.ndn-rte-toolbar');
  });
});
