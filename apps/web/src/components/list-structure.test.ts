// 2026-09-02: a static check for one specific mistake that is very easy to
// make with Astro islands and very slow to find out about.
//
// Astro wraps a `client:only` (or `client:load`) island in an
// `<astro-island>` element. Put one directly inside a `<ul>` — which reads
// perfectly naturally, because the *component* renders `<li>`s — and the
// built markup has a list whose direct child is not a list item. axe's
// `list` rule calls that serious (WCAG 1.3.1), and because navigation is
// shared, it fails **every public page at once**.
//
// That is exactly what happened when the site nav's sign-in links became a
// session-aware island: twelve axe failures, one per page, none of them
// about the page they named. And the only thing that could tell us was
// `tests/pr-env/a11y-full.test.ts`, which needs a deployed ephemeral stack
// and eleven minutes.
//
// This is the cheap half of that check: it reads the built `dist/` and
// needs no browser, no axe, and no deploy. It cannot replace the real axe
// scan — it knows one rule — but this is the rule that a component
// refactor is most likely to break, and the one whose blast radius is
// every page in the site.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = new URL('../..', import.meta.url).pathname;

function filesUnder(root: string, extensions: readonly string[]): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      return filesUnder(path, extensions);
    }
    return extensions.some((extension) => entry.name.endsWith(extension)) ? [path] : [];
  });
}

/**
 * The element names a `<ul>`/`<ol>` may have as a *direct* child, per the
 * HTML spec and axe's `only-listitems` check. `template` is included for
 * the same reason axe includes it.
 */
const ALLOWED_LIST_CHILDREN = new Set(['li', 'script', 'template']);

/**
 * Direct children of every `<ul>`/`<ol>` in one document, as tag names.
 *
 * Deliberately a shallow, non-nesting scan rather than a real parser: it
 * walks a list's own content and counts depth, so a `<ul>` inside an
 * `<li>` is attributed to that inner list and not to the outer one. Good
 * enough for the one rule this file knows, and it keeps the check free of
 * a DOM dependency in a `node` test environment.
 */
export function directListChildren(html: string): string[] {
  const found: string[] = [];
  const listOpen = /<(ul|ol)\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = listOpen.exec(html)) !== null) {
    const listTag = (match[1] ?? '').toLowerCase();
    let depth = 1;
    const child = /<(\/?)([a-z0-9-]+)\b[^>]*?(\/?)>/gi;
    child.lastIndex = listOpen.lastIndex;
    let inner: RegExpExecArray | null;
    let nested = 0;
    while ((inner = child.exec(html)) !== null) {
      const closing = inner[1] === '/';
      const name = (inner[2] ?? '').toLowerCase();
      const selfClosing = inner[3] === '/';
      if (name === listTag && !closing) {
        depth += 1;
      } else if (name === listTag && closing) {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
      // Only elements opened at the list's own depth are its direct
      // children; anything inside an `<li>` belongs to that item.
      if (depth === 1 && !closing) {
        if (nested === 0) {
          found.push(name);
        }
        if (!selfClosing && name !== 'br' && name !== 'img' && name !== 'input') {
          nested += 1;
        }
      } else if (depth === 1 && closing && nested > 0) {
        nested -= 1;
      }
    }
  }
  return found;
}

describe('every built list contains only list items', () => {
  it('holds across dist/, when a build exists', () => {
    const htmlFiles = filesUnder(join(WEB_ROOT, 'dist'), ['.html']);
    if (htmlFiles.length === 0) {
      // Nothing built here yet — recorded rather than silently skipped,
      // the same precedent `csp-inline-scripts.test.ts` sets for the
      // identical situation.
      expect(htmlFiles).toEqual([]);
      return;
    }

    const offenders: string[] = [];
    for (const path of htmlFiles) {
      for (const child of directListChildren(readFileSync(path, 'utf8'))) {
        if (!ALLOWED_LIST_CHILDREN.has(child)) {
          offenders.push(`${path.slice(WEB_ROOT.length)}: <${child}>`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });
});

describe('directListChildren', () => {
  it('catches an island placed straight inside a list — the 2026-09-02 mistake', () => {
    const html = '<ul><li>a</li><astro-island uid="x"></astro-island></ul>';
    expect(directListChildren(html)).toContain('astro-island');
  });

  it('accepts a list of plain items', () => {
    expect(directListChildren('<ul><li>a</li><li>b</li></ul>')).toEqual(['li', 'li']);
  });

  it('does not blame the outer list for a nested one\'s children', () => {
    // The inner `<ul>` is inside an `<li>`, which is legal; its own
    // children are its own business.
    const html = '<ul><li><ul><li>deep</li></ul></li></ul>';
    expect(directListChildren(html).filter((tag) => tag !== 'li' && tag !== 'ul')).toEqual([]);
  });

  it('does not treat an element inside a list item as a direct child', () => {
    expect(directListChildren('<ul><li><a href="#">x</a></li></ul>')).toEqual(['li']);
  });
});
