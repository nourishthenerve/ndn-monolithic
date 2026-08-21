import { routes } from '@ndn/web/routes.js';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

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

// Gate G1 action item 3 (docs/plan/gate-g1-report.md §7a): containers whose
// focusable content is mounted by a third party, outside this repo's DOM.
// TASK 1.4.1's Turnstile widget is the only one today: `.cf-turnstile` is
// ours, but Cloudflare replaces its contents with a **closed** shadow root
// holding a cross-origin `<iframe>`, so the widget's real tab stops are
// invisible to `focusableSelector` above, to `page.locator()`, and to axe
// (which is why a11y-full.test.ts passes these routes while this suite did
// not). `document.activeElement` retargets every one of them to the
// unnamed wrapper `<div>`, which is what made them look — from the light
// DOM — like empty elements eating focus.
//
// They are not: the stop is a visible 300x65 iframe titled "Widget
// containing a Cloudflare security challenge", plus its own internal
// controls. The walk below therefore steps *over* a third-party region
// rather than asserting an exact light-DOM sequence through it, and the
// dedicated step further down asserts the property that actually matters
// — that the region is a real, visible, accessibly-named widget and not an
// empty focus sink.
const thirdPartyFocusRegionSelector = '.cf-turnstile';

// Bounded on purpose. Skipping a third-party region's stops must not also
// skip a genuine focus trap inside it: past this many consecutive stops
// without leaving the region, the walk fails instead of tabbing forever.
const maxThirdPartyFocusStops = 8;

const turnstileFrameHost = 'challenges.cloudflare.com';

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

function hasTurnstileFrame(page: Page): boolean {
  return page.frames().some((frame) => frame.url().includes(turnstileFrameHost));
}

/**
 * True while keyboard focus sits on (or inside) the third-party widget
 * region. `contains(activeElement)` is what makes this work across the
 * closed shadow root: focus inside it retargets to the host element, which
 * is still a descendant of our own container. Reached from the region's
 * own element rather than a bare `document` reference so this file stays
 * within tsconfig.base.json's `lib: ["ES2022"]` — the same constraint the
 * `addInitScript({ content })` below is written around.
 */
function focusIsInsideThirdPartyRegion(page: Page): Promise<boolean> {
  return page
    .locator(thirdPartyFocusRegionSelector)
    .evaluate((region) => region.contains(region.ownerDocument.activeElement));
}

/** Tab forward until focus leaves the third-party region, or fail if it never does. */
async function tabPastThirdPartyRegions(page: Page, routePath: string): Promise<void> {
  for (let stops = 0; await focusIsInsideThirdPartyRegion(page); stops += 1) {
    if (stops >= maxThirdPartyFocusStops) {
      throw new Error(
        `${routePath}: focus is still inside "${thirdPartyFocusRegionSelector}" after ` +
          `${maxThirdPartyFocusStops} Tab presses — that is a focus trap, not a widget's own stops.`,
      );
    }
    await page.keyboard.press('Tab');
  }
}

for (const route of routes) {
  test(`${route.path} — skip link, tab order, and no focus trap`, async ({ page }) => {
    // TASK 1.2.3: pre-record consent so the cookie banner (shown only on a
    // genuine first visit — see cookie-consent.test.ts, which owns that
    // state) never adds unaccounted-for focusables to this walkthrough.
    // An init script, not a post-goto cookie write, so it's in place
    // before the page's own wiring script ever runs — no race with it.
    // `{ content }`, not a closure, so this file doesn't need `dom` added
    // to tsconfig's `lib` just for a `document` reference that only ever
    // runs inside the browser.
    await page.addInitScript({
      content: "document.cookie = 'ndn_consent=essential%2Canalytics; path=/; max-age=31536000';",
    });
    await page.goto(`${getBaseUrl()}${route.path}`);

    // Settle the third-party widget before counting anything. It mounts
    // asynchronously from a remote script, so a walk started too early
    // would race it — passing or failing depending on network timing
    // rather than on the page.
    const thirdPartyRegion = page.locator(thirdPartyFocusRegionSelector);
    const hasThirdPartyRegion = (await thirdPartyRegion.count()) > 0;
    if (hasThirdPartyRegion) {
      await expect
        .poll(() => hasTurnstileFrame(page), {
          message: `${route.path} renders ${thirdPartyFocusRegionSelector} but no challenge frame ever attached`,
          timeout: 20_000,
        })
        .toBe(true);
    }

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
        // A third-party widget's own stops sit between two of *our*
        // elements; step over them (bounded) and hold the ordering
        // assertion on the elements this repo actually controls.
        if (hasThirdPartyRegion) {
          await tabPastThirdPartyRegions(page, route.path);
        }
        await expect(expected).toBeFocused();
      }
    });

    if (hasThirdPartyRegion) {
      await test.step('the third-party widget is a visible, accessibly-named tab stop — not an empty focus sink', async () => {
        await expect(thirdPartyRegion).toBeVisible();

        const frame = page.frames().find((f) => f.url().includes(turnstileFrameHost));
        if (!frame) {
          throw new Error(`${route.path}: no ${turnstileFrameHost} frame attached`);
        }

        // frameElement() reaches the iframe through the closed shadow root
        // that page.locator('iframe') cannot see — the only way to assert
        // on the element that actually receives the keyboard focus.
        // An ElementHandle, not a Locator, so this is `isVisible()` rather
        // than a web-first `toBeVisible()` — the region's own visibility is
        // already asserted (and auto-retried) above.
        const frameElement = await frame.frameElement();
        expect(await frameElement.isVisible(), 'the widget iframe is hidden').toBe(true);
        expect(
          ((await frameElement.getAttribute('title')) ?? '').trim(),
          'the widget takes keyboard focus, so it must carry an accessible name',
        ).not.toBe('');
      });
    }

    await test.step('no unintended focus trap at the end of the page', async () => {
      await page.keyboard.press('Tab');
      await expect(last).not.toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(last).toBeFocused();
    });

    await test.step('Enter and Space both activate a focused button (native semantics, proven not assumed)', async () => {
      // Gate G1 action item 3 (§7b): the *first visible* button, not the
      // first matching one. `.ndn-button` also matches the cookie banner's
      // two buttons, hidden here by the pre-recorded consent above — and on
      // a route whose only buttons are those, focusing one is a silent
      // no-op that leaves focus wherever it was, so the subsequent Enter
      // activated whatever still held it (on /en/blog, the footer's last
      // link, navigating away mid-test).
      const [button] = await visibleFocusables(page.locator('.ndn-button'));

      if (!button) {
        // No visible button is a legitimate state for a listing page whose
        // content API is flag-gated off (gate-g1-report.md §3a) — but prove
        // that *is* the state rather than skipping quietly: the page must
        // still carry the banner's buttons, and every button it has must be
        // one of them. A route that lost a visible button for any other
        // reason fails here.
        const allButtons = page.locator('.ndn-button');
        const bannerButtons = page.locator('.ndn-cookie-banner .ndn-button');
        await expect(bannerButtons).not.toHaveCount(0);
        expect(await allButtons.count()).toBe(await bannerButtons.count());
        test.info().annotations.push({
          type: 'no-visible-button',
          description: `${route.path} renders no visible .ndn-button — only the hidden cookie banner's. Native button semantics are covered by the other routes and by packages/ui's own suite.`,
        });
        return;
      }

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

      // Re-focus rather than chaining the second key press. On the two form
      // routes this button is a real `type="submit"`, so Enter fires the
      // click *and* then native constraint validation moves focus to the
      // first invalid required field — correct browser behaviour, and the
      // reason a chained Enter-then-Space cannot assume focus stayed put.
      // The claim under test is "a focused button is activated by Space",
      // not "focus survives the previous activation".
      await button.focus();
      await page.keyboard.press('Space');
      await expect(button).toHaveAttribute('data-activation-count', '2');
    });
  });
}
