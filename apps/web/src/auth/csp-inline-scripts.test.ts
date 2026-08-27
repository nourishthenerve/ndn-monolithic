// Found live, 2026-08-27, the first time `auth.webSignIn.enabled` was ever
// turned on in production: every `client:only="react"` island — the entire
// authenticated account shell — silently failed to hydrate, because
// `infra/src/web-stack.ts`'s CSP had no `'unsafe-inline'`, hash, or nonce
// for `script-src`, and Astro's own `client:only` hydration runtime emits
// two small inline `<script>` blocks (never a `src=` file). No prior
// task's Verification line caught this — each checked build output or an
// unauthenticated per-PR stack, never a real rendered, signed-in DOM.
//
// This is that check, moved as early as a build-output scan can run: it
// scans the real built `dist/` HTML for every inline `<script>` (no `src`
// attribute — an external file is already covered by `script-src 'self'`
// and needs no hash), computes each one's CSP `sha256-` hash exactly as a
// browser would, and asserts every one it finds is already allow-listed in
// `web-stack.ts`'s own CSP string — read from that file directly, not
// duplicated here, so the two cannot silently drift apart
// (`docs/runbooks/iam-deny-guardrails.md`'s own
// "`guardrails.test.ts` fails CI if the two ever drift" precedent, applied
// here to a CSP string instead of an IAM policy document).
//
// A future Astro upgrade that changes this boilerplate's byte content, or
// any future task that adds a *new* inline script anywhere on the site,
// fails this test the moment `dist/` is built — not silently, live, again.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const WEB_STACK_PATH = fileURLToPath(
  new URL('../../../../infra/src/web-stack.ts', import.meta.url),
);

function filesUnder(directory: string, extensions: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesUnder(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

/** Every inline `<script>…</script>` body in an HTML file — never a `<script src=…>`. */
function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const pattern = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    const body = match[1] ?? '';
    if (body.trim().length > 0) bodies.push(body);
  }
  return bodies;
}

function cspHashOf(scriptBody: string): string {
  return `sha256-${createHash('sha256').update(scriptBody, 'utf8').digest('base64')}`;
}

/** The `script-src` allow-list actually shipped, read from `web-stack.ts` itself. */
function allowedHashesInWebStack(): string[] {
  const source = readFileSync(WEB_STACK_PATH, 'utf8');
  return [...source.matchAll(/'(sha256-[A-Za-z0-9+/]+=*)'/g)].map((match) => match[1] as string);
}

describe('every inline script in the built site is CSP-hash-allow-listed', () => {
  it('holds across dist/, when a build exists', () => {
    const htmlFiles = filesUnder(join(WEB_ROOT, 'dist'), ['.html']);
    if (htmlFiles.length === 0) {
      // Nothing built here yet — recorded, not silently skipped, matching
      // no-browser-storage.test.ts's own precedent for the same reason.
      expect(htmlFiles).toEqual([]);
      return;
    }

    const allowed = new Set(allowedHashesInWebStack());
    expect(allowed.size).toBeGreaterThan(0);

    const found = new Set<string>();
    for (const path of htmlFiles) {
      const html = readFileSync(path, 'utf8');
      for (const body of inlineScriptBodies(html)) {
        found.add(cspHashOf(body));
      }
    }

    // The account shell's `client:only="react"` islands are the reason
    // this test exists — if a future build stops emitting any inline
    // script at all, that is itself a signal worth seeing, not a reason
    // for this test to pass by vacuous truth.
    expect(found.size).toBeGreaterThan(0);

    const unlisted = [...found].filter((hash) => !allowed.has(hash));
    expect(unlisted).toEqual([]);
  });
});
