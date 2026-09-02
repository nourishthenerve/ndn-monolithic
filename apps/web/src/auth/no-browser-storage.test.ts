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

// `document.cookie` was forbidden outright on auth paths, on the grounds
// that "on an auth path it would be a token in a cookie script can read —
// which is precisely what `HttpOnly` exists to prevent." The cookie-consent
// banner (BaseLayout, TASK 1.2.3) legitimately reads and writes one, and it
// is not a session, so the ban was scoped to auth.
//
// **2026-09-02: narrowed from a proxy to the thing itself.** The ban was a
// stand-in for a guarantee the *browser* already enforces: an `HttpOnly`
// cookie is not in `document.cookie` at all, so a read on an auth path
// cannot return a session token no matter what it does with the result.
// What actually has to hold is that no auth code *writes* a cookie, and
// that none of the three secret cookies is ever named in something script
// can run.
//
// The narrowing was forced by a real need rather than convenience:
// `session.ts` reads a deliberately-readable companion cookie carrying
// `1`, so that a signed-out visitor's page view costs no `/auth/refresh`
// at all. Keeping the substring ban would have meant either moving that
// read to a different folder to dodge the rule — the same code, hidden —
// or leaving every public page paying for an auth round trip.
//
// The server side is where the real assertion lives: `auth-routes.test.ts`
// asserts every cookie carries `HttpOnly` *except* the one that exists to
// be read, and that the readable one carries `1` and nothing else.
const FORBIDDEN_COOKIE_WRITES = ['document.cookie ='];

/** The three cookies script must never be able to name, let alone read. */
const SECRET_COOKIE_NAMES = ['ndn_refresh', 'ndn_pkce', 'ndn_state'];

const FORBIDDEN_ON_AUTH_PATHS = [...FORBIDDEN_COOKIE_WRITES, ...SECRET_COOKIE_NAMES];

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

/**
 * The auth code that actually ships. Test files are excluded, and only
 * from the *source* scan: they legitimately set up cookie state to drive
 * the thing under test (`session.test.ts` writes the hint cookie so
 * `resolve` has something to find), and none of them reaches a browser.
 * The bundle scan below is what covers shipped code, and it reads `dist/`,
 * where no test file appears.
 */
function authSources(): string[] {
  return filesUnder(join(WEB_ROOT, 'src/auth'), ['.ts', '.tsx']).filter(
    (path) => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx'),
  );
}

function offenders(paths: string[], names: string[]): string[] {
  return paths.filter((path) => {
    const source = stripComments(readFileSync(path, 'utf8'));
    return names.some((name) => source.includes(name));
  });
}

describe('no auth code touches browser storage', () => {
  it('holds across the auth source tree', () => {
    const sources = authSources();

    expect(sources.length).toBeGreaterThan(0);
    expect(offenders(sources, [...FORBIDDEN_ANYWHERE, ...FORBIDDEN_ON_AUTH_PATHS])).toEqual([]);
  });

  // The narrowing above is only safe while the *readable* cookie stays
  // readable-and-worthless. This is the source-side half of that: auth code
  // may look at `document.cookie`, and the only cookie it is allowed to be
  // looking for is the hint.
  it('names no cookie but the session hint', () => {
    const readers = authSources().filter((path) =>
      stripComments(readFileSync(path, 'utf8')).includes('document.cookie'),
    );
    // Vacuous if nothing reads cookies, which would itself be a change
    // worth noticing rather than a reason to pass quietly.
    expect(readers.length).toBeGreaterThan(0);
    for (const path of readers) {
      const source = stripComments(readFileSync(path, 'utf8'));
      const cookieNames = [...new Set([...source.matchAll(/ndn_[a-z_]+/g)].map((m) => m[0]))];
      expect(cookieNames, path).toEqual(['ndn_session']);
    }
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
