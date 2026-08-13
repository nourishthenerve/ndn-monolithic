import { routes } from '@ndn/web/routes.js';
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

import { getBaseUrl } from './env.js';

// TASK 1.1.3: keyboard-only walkthrough of every route in routes.ts.
// packages/ui's primitives are all native semantic HTML (TASK 1.1.1's own
// DoD), so Tab/Enter/Space activation is mostly browser-default behaviour
// — this suite exists to catch the ways that default can still silently
// break: an element visually/structurally out of its DOM tab position, a
// skip-link target that scrolls but never receives real keyboard focus
// (SC 2.4.1), or a trap that stops Tab from ever leaving a component.
const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

async function visibleFocusables(all: Locator): Promise<Locator[]> {
  const count = await all.count();
  const visible: Locator[] = [];
  for (let i = 0; i < count; i += 1) {
    if (await all.nth(i).isVisible()) {
      visible.push(all.nth(i));
    }
  }
  return visible;
}

for (const route of routes) {
  test(`${route.path} — skip link, tab order, and no focus trap`, async ({ page }) => {
    await page.goto(`${getBaseUrl()}${route.path}`);

    const focusables = await visibleFocusables(page.locator(focusableSelector));
    const [first, ...rest] = focusables;
    if (!first) {
      throw new Error(`no focusable elements found on ${route.path}`);
    }
    const last = rest.at(-1) ?? first;

    await test.step('skip link is the first-focusable element on the page', async () => {
      await page.keyboard.press('Tab');
      await expect(page.locator('.ndn-skip-link')).toBeFocused();
      await expect(first).toBeFocused();
    });

    await test.step('activating it moves real keyboard focus into <main>, not just a scroll', async () => {
      await page.keyboard.press('Enter');
      await expect(page.locator('#main')).toBeFocused();
      expect(page.url()).toContain('#main');
    });

    await test.step('remaining tab order matches DOM/visual order', async () => {
      for (const expected of rest) {
        await page.keyboard.press('Tab');
        await expect(expected).toBeFocused();
      }
    });

    await test.step('no unintended focus trap at the end of the page', async () => {
      await page.keyboard.press('Tab');
      await expect(last).not.toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(last).toBeFocused();
    });

    await test.step('Enter and Space both activate a focused button (native semantics, proven not assumed)', async () => {
      const button = page.locator('.ndn-button').first();
      await button.evaluate((el) => {
        el.setAttribute('data-activation-count', '0');
        el.addEventListener('click', () => {
          const next = Number(el.getAttribute('data-activation-count') ?? '0') + 1;
          el.setAttribute('data-activation-count', String(next));
        });
      });
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(button).toHaveAttribute('data-activation-count', '1');
      await page.keyboard.press('Space');
      await expect(button).toHaveAttribute('data-activation-count', '2');
    });
  });
}
