// 2026-09-04: one sign-out control, in the header, and nowhere else.
//
// The owner: *"there are sign out button almost on all page. remove them.
// just keep it at top right for both patients and clinicians/principal."*
//
// Thirteen account pages each rendered their own `<SignOutButton>` at the
// bottom, because every page in the account shell was copied from the one
// before it. A source scan rather than a rendered test: the thing being
// asserted is that these pages do not *contain* the control, which is a
// property of the files, and the fourteenth page will be written by
// copying a thirteenth.
//
// The same shape `components/list-structure.test.ts` and
// `auth/csp-inline-scripts.test.ts` already use — a static check over real
// files, for a rule no single component can enforce about itself.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const WEB_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const ACCOUNT_PAGES_DIR = join(WEB_SRC, 'pages', '[locale]', 'account');

function accountPages(): { name: string; source: string }[] {
  return readdirSync(ACCOUNT_PAGES_DIR)
    .filter((name) => name.endsWith('.astro'))
    .map((name) => ({ name, source: readFileSync(join(ACCOUNT_PAGES_DIR, name), 'utf8') }));
}

describe('sign-out lives in the site header and nowhere else', () => {
  it('finds the account pages it is meant to be scanning', () => {
    // A glob that silently matches nothing would make every assertion
    // below vacuously true — the one failure mode a check like this has.
    expect(accountPages().length).toBeGreaterThanOrEqual(10);
  });

  it.each(accountPages().map((page) => [page.name, page.source]))(
    '%s renders no sign-out control of its own',
    (_name, source) => {
      expect(source).not.toContain('SignOutButton');
    },
  );

  it('is still rendered by the nav island, so removing them left one behind', () => {
    // The other half of the rule, and the one that matters: "no sign-out
    // on the account pages" is satisfied just as well by a site with no
    // sign-out at all.
    const sessionNav = readFileSync(join(WEB_SRC, 'auth', 'SessionNav.tsx'), 'utf8');
    expect(sessionNav).toContain('<SignOutButton');

    const nav = readFileSync(join(WEB_SRC, 'components', 'Nav.astro'), 'utf8');
    expect(nav).toContain('<SessionNav');
  });
});
