import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { primitiveStylesCss } from '../src/components/primitive-styles.js';

// TASK 1.1.2: proof that primitive-styles.ts's directional CSS (skip link
// inset) is written with logical properties (inset-inline-start), not
// physical ones (left) — jsdom (used by every other test in this package)
// doesn't resolve CSS logical properties to their physical equivalents
// based on `dir`, the same reason 1.1.1's reduced-motion spec needed a real
// browser rather than jsdom. `getComputedStyle` here always reports
// physical `left`/`right`, whatever the source CSS was declared with — so a
// flip between ltr and rtl is only observable this way.
function pageHtml(dir: 'ltr' | 'rtl'): string {
  return `<!doctype html>
<html dir="${dir}">
<head><style>${primitiveStylesCss}</style></head>
<body>
  <a href="#main" class="ndn-skip-link ndn-interactive" id="skip">Skip to main content</a>
  <main id="main">Main content</main>
</body>
</html>`;
}

async function physicalInset(page: Page): Promise<{ left: string; right: string }> {
  return page.locator('#skip').evaluate((el) => {
    const computed = getComputedStyle(el);
    return { left: computed.left, right: computed.right };
  });
}

// getComputedStyle on an absolutely-positioned element reports the *used*
// value for whichever inset side the CSS didn't set — a real pixel offset
// from layout, not the literal `auto` keyword — so only the side the
// declaration actually targets is a meaningful assertion here.
test.describe('RTL-safe logical CSS (D-04 / ADR-0012)', () => {
  test('ltr: inset-inline-start resolves to the physical left', async ({ page }) => {
    await page.setContent(pageHtml('ltr'));
    const { left } = await physicalInset(page);
    expect(left).toBe('8px'); // 0.5rem at the default 16px root
  });

  test('rtl: the same declaration resolves to the physical right instead — no broken logical-property fallback', async ({
    page,
  }) => {
    await page.setContent(pageHtml('rtl'));
    const { right } = await physicalInset(page);
    expect(right).toBe('8px');
  });

  test('the physical side actually flips between ltr and rtl for the same source CSS', async ({
    page,
  }) => {
    await page.setContent(pageHtml('ltr'));
    const ltr = await physicalInset(page);

    await page.setContent(pageHtml('rtl'));
    const rtl = await physicalInset(page);

    expect(ltr.left).not.toBe(rtl.left);
    expect(ltr.right).not.toBe(rtl.right);
  });
});
