import { defaultLocale, t } from '@ndn/i18n';
import { expect, test } from '@playwright/test';

import { getBaseUrl } from './env.js';

// TASK 1.2.3: first-visit behaviour of the cookie consent banner, and the
// self-hosted-fonts guarantee — a separate suite from a11y-full.test.ts/
// keyboard.test.ts, which both now pre-record consent (see their own
// addInitScript) so the banner never shows up as an unaccounted-for
// element in those full-route walkthroughs. This suite owns the
// no-consent-recorded state instead.
test.describe('cookie consent banner — no consent recorded', () => {
  test('is visible, keyboard-operable, and rejecting still leaves the site usable', async ({
    page,
  }) => {
    await page.goto(`${getBaseUrl()}/${defaultLocale}`);

    const banner = page.getByRole('region', {
      name: t('cookies.banner.label', undefined, defaultLocale),
    });
    await expect(banner).toBeVisible();

    const rejectButton = banner.getByRole('button', {
      name: t('cookies.banner.reject', undefined, defaultLocale),
    });
    await rejectButton.focus();
    await expect(rejectButton).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(banner).toBeHidden();

    // Rejecting non-essential cookies must not break the rest of the page.
    await expect(page.locator('.ndn-nav-header')).toBeVisible();
  });

  test('accepting records analytics consent and hides the banner', async ({ page }) => {
    await page.goto(`${getBaseUrl()}/${defaultLocale}`);

    const banner = page.getByRole('region', {
      name: t('cookies.banner.label', undefined, defaultLocale),
    });
    await expect(banner).toBeVisible();

    await banner
      .getByRole('button', { name: t('cookies.banner.accept', undefined, defaultLocale) })
      .click();
    await expect(banner).toBeHidden();

    const cookies = await page.context().cookies();
    const consentCookie = cookies.find((cookie) => cookie.name === 'ndn_consent');
    expect(consentCookie?.value).toContain('analytics');
  });

  test('a decision, once recorded, survives a reload — the banner does not show again', async ({
    page,
  }) => {
    await page.goto(`${getBaseUrl()}/${defaultLocale}`);
    await page
      .getByRole('button', { name: t('cookies.banner.reject', undefined, defaultLocale) })
      .click();

    await page.reload();

    const banner = page.getByRole('region', {
      name: t('cookies.banner.label', undefined, defaultLocale),
    });
    await expect(banner).toBeHidden();
  });

  test('links to the real cookie policy page', async ({ page }) => {
    await page.goto(`${getBaseUrl()}/${defaultLocale}`);

    const policyLink = page.getByRole('link', {
      name: t('cookies.banner.policyLink', undefined, defaultLocale),
    });
    await expect(policyLink).toHaveAttribute('href', `/${defaultLocale}/legal/cookies`);
  });
});

test.describe('self-hosted fonts', () => {
  test('no font request leaves the page for a non-self origin', async ({ page }) => {
    const externalFontRequests: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (/\.(woff2?|ttf|otf)(\?|$)/i.test(url) && !url.startsWith(getBaseUrl())) {
        externalFontRequests.push(url);
      }
    });

    await page.goto(`${getBaseUrl()}/${defaultLocale}`);
    await page.waitForLoadState('networkidle');

    expect(externalFontRequests).toEqual([]);
  });
});
