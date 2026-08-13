import { AxeBuilder } from '@axe-core/playwright';
import { routes } from '@ndn/web/routes.js';
import { expect, test } from '@playwright/test';

import { getBaseUrl } from './env.js';

// TASK 1.1.3: real-browser accessibility gate across every public route —
// supersedes TASK 0.6.3's a11y.test.ts, which ran axe-core against jsdom
// (no real layout/rendering, so color-contrast and several other checks
// could only ever land in `incomplete`, never a real pass/fail). Reads
// `routes.ts` rather than a hard-coded list so a page that ships without
// registering itself there silently drops out of this gate instead of the
// gate silently staying green — routes.ts's own DoD is what prevents that.
for (const route of routes) {
  test(`${route.path} has no automatically-detectable axe violations`, async ({ page }) => {
    // TASK 1.2.3: pre-record consent so this scan covers the steady state
    // every returning visitor sees — the banner's own first-visit
    // accessibility is asserted separately in cookie-consent.test.ts.
    // `{ content }`, not a closure — see keyboard.test.ts's own comment.
    await page.addInitScript({
      content: "document.cookie = 'ndn_consent=essential%2Canalytics; path=/; max-age=31536000';",
    });
    await page.goto(`${getBaseUrl()}${route.path}`);

    const results = await new AxeBuilder({ page }).analyze();

    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
