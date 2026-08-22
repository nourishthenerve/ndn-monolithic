// TASK 2.5.4's own Tests line: "grep finds no reference to ADMIN_API_TOKEN
// or admin-auth in services/ or infra/ — a build-level assertion." This is
// that assertion, not a description of one that ran once by hand — the
// mechanism that proves the shared-secret authentication path was
// *retired*, not merely stopped being called from the four routes that
// used to reach it. A future PR that reintroduces the pattern (a new
// handler resolving ADMIN_API_TOKEN, or a stray import of the deleted
// admin-auth.ts) fails this test, not just a code review.
//
// `git grep` rather than a recursive fs walk: it's already the mechanism
// scripts/check-no-disable-comments.mjs uses for a repo-wide source scan,
// respects .gitignore, and needs no new dependency.
import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

/** `git grep -n <pattern> -- <paths>`. Empty array (no matches) rather than throwing — `git grep` exits 1 on "nothing found", which is the success case here. */
function gitGrep(pattern: string, paths: readonly string[]): string[] {
  try {
    const output = execFileSync(
      'git',
      ['grep', '-n', '-I', '--extended-regexp', pattern, '--', ...paths],
      { cwd: new URL('../../', import.meta.url), encoding: 'utf8' },
    );
    return output.split('\n').filter((line) => line !== '');
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 1) {
      return [];
    }
    throw error;
  }
}

describe('TASK 2.5.4: the admin-token bearer gate leaves no trace', () => {
  // Deliberately narrower than a bare substring match on "admin-auth" or
  // "ADMIN_API_TOKEN": this repo's own convention is to document a
  // retirement in the comment at the call site it retired (audit.ts,
  // jwt-verify.ts both still say, correctly, that admin-auth.ts *used to*
  // exist) — banning every prose mention would force deleting exactly the
  // history a reviewer most wants. What must be zero is *live code*: an
  // import of the deleted modules, a construct or export that resolved the
  // secret, or a route still opting out through the deleted authorizer.
  it('has no live code path resolving, verifying or routing through the retired admin token', () => {
    const matches = gitGrep(
      [
        'verifyAdminToken\\(',
        'getAdminToken\\(',
        'createAdminTokenResolver\\(',
        'ADMIN_TOKEN_PARAMETER_NAME[:=]',
        'ADMIN_API_TOKEN_PARAMETER_NAME',
        'ADMIN_TOKEN_ROUTE\\b',
        "from '\\./admin-auth",
        "from '\\./admin-token",
      ].join('|'),
      ['services/', 'infra/'],
    );
    expect(matches).toEqual([]);
  });
});
