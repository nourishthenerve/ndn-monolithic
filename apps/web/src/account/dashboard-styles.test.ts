import { describe, expect, it } from 'vitest';

import { accountDashboardStylesCss } from './dashboard-styles.js';

// Same reasoning as `calendar-styles.test.ts` and `caseload-styles.test.ts`:
// a stylesheet held as a string can be read as text, and what is worth
// checking is the coupling between a class the page emits and the rule that
// styles it — plus the one mistake that has broken this pattern before.
describe('accountDashboardStylesCss', () => {
  it('draws the dashboard’s navigation links as controls rather than a bulleted list', () => {
    // The owner has called these "buttons" since they were built; the change
    // is that they are now drawn as such. They stay <a>s, so the rule has to
    // reach them through .ndn-link.
    expect(accountDashboardStylesCss).toContain('.ndn-account-nav ul');
    expect(accountDashboardStylesCss).toContain('list-style: none');
    expect(accountDashboardStylesCss).toContain('.ndn-account-nav .ndn-link');
  });

  it('beats packages/ui’s own .ndn-link on specificity rather than on source order', () => {
    // 0-2-0 against 0-1-0. The two stylesheets are injected by different
    // parts of the layout, so a rule that only wins because of where it
    // lands is a rule that stops winning when something moves — the same
    // call `calendar-styles.ts` documents for its join link.
    const rules = accountDashboardStylesCss.match(/^\.ndn-link\b/m);
    expect(rules).toBeNull();
    expect(accountDashboardStylesCss).toMatch(/\.ndn-account-nav \.ndn-link[\s,{:]/);
  });

  it('brings the underline back on hover — these are still links, and still go somewhere', () => {
    expect(accountDashboardStylesCss).toMatch(
      /\.ndn-account-nav \.ndn-link:hover \{[^}]*text-decoration: underline/,
    );
  });

  it('names only colour custom properties, so the palette stays in one file', () => {
    expect(
      accountDashboardStylesCss.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g) ?? [],
    ).toEqual([]);
  });

  it('carries no backtick, which would end the template literal it lives in', () => {
    expect(accountDashboardStylesCss).not.toContain('`');
  });
});
