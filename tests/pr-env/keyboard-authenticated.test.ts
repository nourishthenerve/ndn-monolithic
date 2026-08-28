// TASK 5.3.2: the keyboard-completeness half of the live-session sweep —
// `a11y-authenticated.test.ts` (TASK 5.3.1) proves every registered
// account-shell route is free of automatically-detectable axe violations;
// axe cannot prove a keyboard-only walkthrough actually reaches and
// activates everything, the same gap `keyboard.test.ts` (TASK 1.1.3)
// already closes for the public route set. This is that suite's
// authenticated counterpart: same walkthrough (skip link first, tab order
// matches DOM/visual order, no unintended trap, Enter and Space both
// activate a focused button), run against `account-routes.ts` instead of
// `routes.ts`, against **production**, in the same signed-in `chromium`
// project `a11y-authenticated.test.ts` already runs in (see
// playwright.account-a11y.config.ts) — no second real Cognito sign-in.
//
// No third-party-widget handling here, unlike keyboard.test.ts: the only
// third-party focus region in this codebase is the contact form's
// Turnstile widget (TASK 1.4.1), which no account-shell page renders.
import { accountRoutes } from '@ndn/web/account-routes.js';
import { expect, test } from '@playwright/test';
import type { Locator } from '@playwright/test';

import { getTestAppointmentId, PRODUCTION_BASE_URL } from './account-env.js';

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

for (const route of accountRoutes) {
  test(`${route.path} (clinician session) — skip link, tab order, and no focus trap`, async ({
    page,
  }) => {
    const appointmentId = getTestAppointmentId();
    const url =
      route.needsAppointmentId && appointmentId
        ? `${PRODUCTION_BASE_URL}${route.path}?appointmentId=${encodeURIComponent(appointmentId)}`
        : `${PRODUCTION_BASE_URL}${route.path}`;

    if (route.needsAppointmentId && !appointmentId) {
      test.info().annotations.push({
        type: 'no-appointment-fixture',
        description:
          `${route.path}: A11Y_TEST_APPOINTMENT_ID is not set, so this walks the ` +
          "page's too-early/join-denied state rather than a real in-call state. " +
          'See docs/runbooks/live-session-accessibility.md.',
      });
    }
    if (route.ownerRole === 'patient') {
      test.info().annotations.push({
        type: 'wrong-role-content-unscanned',
        description:
          `${route.path}: walked with the clinician identity only. This route's ` +
          'real, patient-owned content is not covered by this run — only its ' +
          'legible forbidden state is. See a11y-authenticated.test.ts\'s own header.',
      });
    }

    // TASK 1.2.3: pre-record consent so the cookie banner never adds an
    // unaccounted-for focusable to this walkthrough — same reasoning as
    // keyboard.test.ts's identical init script.
    await page.addInitScript({
      content: "document.cookie = 'ndn_consent=essential%2Canalytics; path=/; max-age=31536000';",
    });
    await page.goto(url);

    // RequireAuth renders a `role="status"` line while the session
    // resolves and nothing else until it does (RequireAuth.tsx) — the same
    // wait a11y-authenticated.test.ts uses, so this walk counts the page's
    // real content (or real forbidden state), not a transient loading one.
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 15_000 });

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
      // Same graceful fallback as keyboard.test.ts: BaseLayout renders the
      // (pre-consented, hidden) CookieBanner on every account page too, so
      // a route with no real button of its own — a forbidden-state page
      // with only links, or `call`'s too-early state — still carries the
      // banner's two, and only those. A route that lost a visible button
      // for any other reason fails here rather than skipping quietly.
      const [button] = await visibleFocusables(page.locator('.ndn-button'));

      if (!button) {
        const allButtons = page.locator('.ndn-button');
        const bannerButtons = page.locator('.ndn-cookie-banner .ndn-button');
        await expect(bannerButtons).not.toHaveCount(0);
        expect(await allButtons.count()).toBe(await bannerButtons.count());
        test.info().annotations.push({
          type: 'no-visible-button',
          description: `${route.path} renders no visible .ndn-button — only the hidden cookie banner's.`,
        });
        return;
      }

      // Unlike the public suite's fixture forms, a real button here can
      // carry a real, live side effect against production — `account`'s
      // own SignOutButton revokes the session's refresh token and
      // navigates (SignInPanel.tsx), and `messages`'s composer submits a
      // real message between a real patient and clinician. Neither may
      // run just to prove Enter/Space dispatches a click. The listener is
      // attached directly on the button itself, so it runs at the target
      // phase before React's own delegated handler (attached on an
      // ancestor root, reached only during bubbling) ever sees the event:
      // `stopPropagation()` keeps that handler from firing at all, and
      // `preventDefault()` separately blocks the button's own default
      // action (e.g. native form submission) — the click is real and
      // counted, its application-level consequence is not.
      await button.evaluate((el) => {
        el.setAttribute('data-activation-count', '0');
        el.addEventListener(
          'click',
          (event: { preventDefault(): void; stopPropagation(): void }) => {
            event.preventDefault();
            event.stopPropagation();
            const next = Number(el.getAttribute('data-activation-count') ?? '0') + 1;
            el.setAttribute('data-activation-count', String(next));
          },
          { capture: false },
        );
      });
      await button.focus();
      await page.keyboard.press('Enter');
      await expect(button).toHaveAttribute('data-activation-count', '1');

      // Re-focus rather than chaining the second key press, matching
      // keyboard.test.ts's own precedent of not assuming focus survives
      // the previous activation.
      await button.focus();
      await page.keyboard.press('Space');
      await expect(button).toHaveAttribute('data-activation-count', '2');
    });
  });
}
