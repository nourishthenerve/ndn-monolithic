// TASK 2.2.4's build-output assertion: no bundle contains a
// `localStorage`/`sessionStorage` write on an auth path.
//
// It is written as a *build-output* check rather than a source check
// because that is where the mistake actually lands — a dependency, a
// helper pulled in from `@ndn/ui`, or a future refactor that "just caches
// the token" all show up in `dist/` whether or not they are visible in
// `apps/web/src/auth`. The source scan runs too, and is what guards the
// case where `dist/` has not been built yet: `pnpm test` must not pass
// merely because there was nothing to look at.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));

// Two rules, because the two APIs are not equally out of bounds.
//
// `localStorage`/`sessionStorage` are forbidden **site-wide**. Nothing on
// this site legitimately uses either, and the moment something does, the
// question "is that an auth path?" becomes a judgement call in a test that
// should not be making one.
const FORBIDDEN_ANYWHERE = ['localStorage', 'sessionStorage'];

// `document.cookie` is forbidden on auth paths only. The cookie-consent
// banner (BaseLayout, TASK 1.2.3) legitimately reads and writes one, and
// it is not a session. On an auth path it would be a token in a cookie
// script can read — which is precisely what `HttpOnly` exists to prevent.
const FORBIDDEN_ON_AUTH_PATHS = ['document.cookie'];

/** Comments say these words on purpose. Only code counts. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

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

function offenders(paths: string[], names: string[]): string[] {
  return paths.filter((path) => {
    const source = stripComments(readFileSync(path, 'utf8'));
    return names.some((name) => source.includes(name));
  });
}

describe('no auth code touches browser storage', () => {
  it('holds across the auth source tree', () => {
    const sources = filesUnder(join(WEB_ROOT, 'src/auth'), ['.ts', '.tsx']).filter(
      (path) => !path.endsWith('no-browser-storage.test.ts'),
    );

    expect(sources.length).toBeGreaterThan(0);
    expect(offenders(sources, [...FORBIDDEN_ANYWHERE, ...FORBIDDEN_ON_AUTH_PATHS])).toEqual([]);
  });

  it('holds across every built bundle, when a build exists', () => {
    const bundles = filesUnder(join(WEB_ROOT, 'dist'), ['.js']);
    if (bundles.length === 0) {
      // Nothing built here yet. The source scan above is the guarantee in
      // that case, and this is recorded rather than silently skipped.
      expect(bundles).toEqual([]);
      return;
    }

    expect(offenders(bundles, FORBIDDEN_ANYWHERE)).toEqual([]);

    // The bundles that actually carry auth code, found by the routes they
    // call rather than by filename — a chunk name is Vite's to choose.
    const authBundles = bundles.filter((path) => readFileSync(path, 'utf8').includes('/auth/'));
    expect(authBundles.length).toBeGreaterThan(0);
    expect(offenders(authBundles, FORBIDDEN_ON_AUTH_PATHS)).toEqual([]);
  });
});
