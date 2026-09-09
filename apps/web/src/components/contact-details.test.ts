// 2026-09-09: two static checks over the built `dist/`, both about the same
// bug.
//
// `LegalPage.astro` shipped `<Button>Contact us</Button>` — no `href`, no
// handler, no form — on all five legal pages for nine days after D-32
// deleted the contact form it was authored against. Nothing failed: the
// page built, the route resolved, and axe is perfectly happy with a button
// that has an accessible name and does nothing. Only a person clicking it
// could tell, and the owner was the person who did.
//
// So the first check is that the details are actually there, and the second
// is the general shape of that mistake: a `<button>` on a static page with
// nothing that could possibly be listening to it.
//
// Both read the real build output rather than the source, for the same
// reason `list-structure.test.ts` and `auth/csp-inline-scripts.test.ts` do —
// what ships is the only thing worth asserting about, and it costs no
// browser and no deploy. `pnpm test` runs `build:web` first.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { contactEmail, whatsappBusinessNumber, whatsappChatUrl } from '../site-config.js';

const DIST = fileURLToPath(new URL('../../dist', import.meta.url));

function htmlFilesUnder(root: string): string[] {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return htmlFilesUnder(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

function builtPages(): { path: string; html: string }[] {
  const files = htmlFilesUnder(DIST);
  // A guard on the guard: an empty `dist/` would make every assertion below
  // pass by having nothing to check.
  expect(files.length).toBeGreaterThan(0);
  return files.map((path) => ({ path, html: readFileSync(path, 'utf8') }));
}

/**
 * The markup no client-side framework will ever attach a handler to: this
 * document with every `<astro-island>` removed.
 *
 * `<style>` and `<script>` bodies go too, and that is not tidiness — this
 * project writes long prose comments inside its stylesheets, several of
 * which say the words `<button>` while explaining why something is one.
 * Scanning the raw HTML found three of those on `/en/account` and called
 * them dead controls.
 */
function staticMarkupOf(html: string): string {
  return html
    .replace(/<astro-island\b[\s\S]*?<\/astro-island>/g, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
}

describe('the contact block, as built', () => {
  const pagesWithBlock = builtPages().filter(({ html }) => html.includes('data-contact-details'));

  it('is on the landing page, the contact page and all five legal pages', () => {
    const routes = pagesWithBlock
      .map(({ path }) => path.slice(DIST.length).replace(/\/index\.html$/, '') || '/')
      .sort();

    expect(routes).toEqual([
      '/en',
      '/en/contact',
      '/en/legal/accessibility-statement',
      '/en/legal/clinical-disclaimer',
      '/en/legal/cookies',
      '/en/legal/privacy',
      '/en/legal/terms',
    ]);
  });

  it('shows both the address and the number, each in a link that acts on it', () => {
    for (const { path, html } of pagesWithBlock) {
      // The values as readable text, not only inside an href — someone
      // reading the number out to a relative never opens the link.
      expect(html, path).toContain(`>${contactEmail}</a>`);
      expect(html, path).toContain(whatsappBusinessNumber);
      expect(html, path).toContain(`href="mailto:${contactEmail}"`);
      expect(html, path).toContain(`href="${whatsappChatUrl(whatsappBusinessNumber)}"`);
    }
  });

  it('ships the copy buttons hidden, so a page whose script never ran shows no dead control', () => {
    for (const { path, html } of pagesWithBlock) {
      const copyButtons = [...html.matchAll(/<button\b[^>]*data-contact-copy=[^>]*>/g)].map(
        (match) => match[0],
      );
      expect(copyButtons.length, path).toBe(2);
      for (const button of copyButtons) {
        expect(button, path).toMatch(/\bhidden\b/);
      }
    }
  });

  it('wires those buttons from an external script, never an inline one', () => {
    // An inline `<script>` would need its sha256 added to web-stack.ts's
    // CSP (see auth/csp-inline-scripts.test.ts, which enforces exactly
    // that). This asserts the other half: the file is real and referenced.
    for (const { path, html } of pagesWithBlock) {
      expect(html, path).toMatch(/<script type="module" src="\/_astro\/ContactDetails\.astro/);
    }
  });
});

describe('no static page ships a button nothing is listening to', () => {
  // The class of bug the dead "Contact us" CTA was. A `<button>` outside
  // every `<astro-island>` gets no React handler — the only thing that can
  // drive it is a hoisted script finding it by attribute — so one with no
  // `data-*` hook and no `type="submit"` is inert by construction, whatever
  // its label promises.
  //
  // Buttons *inside* an island are excluded rather than trusted blindly:
  // their handlers are props of a hydrated component, and asserting
  // anything about them from the HTML would only be guesswork.
  it('every button outside an island has a data-* hook or submits a form', () => {
    const offenders: string[] = [];

    for (const { path, html } of builtPages()) {
      for (const match of staticMarkupOf(html).matchAll(/<button\b[^>]*>/g)) {
        const tag = match[0];
        if (/\sdata-[a-z-]+/.test(tag) || /type="submit"/.test(tag)) continue;
        offenders.push(`${path.slice(DIST.length)}: ${tag}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
