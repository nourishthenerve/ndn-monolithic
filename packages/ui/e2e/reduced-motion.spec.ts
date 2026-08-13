import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import { primitiveStylesCss } from '../src/components/primitive-styles.js';
import { motionTokens, reducedMotionGlobalCss } from '../src/tokens/motion.js';

// The skip link is the one component whose transition is actually
// observable pre-interaction (`.ndn-skip-link`'s `inset-block-start`
// slides on `:focus`) — see primitive-styles.ts.
const pageHtml = `<!doctype html>
<html>
<head><style>${reducedMotionGlobalCss}\n${primitiveStylesCss}</style></head>
<body>
  <a href="#main" class="ndn-skip-link ndn-interactive" id="skip">Skip to main content</a>
  <main id="main">Main content</main>
</body>
</html>`;

async function transitionDurationSeconds(page: Page): Promise<number> {
  const raw = await page.locator('#skip').evaluate((el) => getComputedStyle(el).transitionDuration);
  return Number.parseFloat(raw);
}

test.describe('SC 2.3.3 — reduced motion', () => {
  test('with no motion preference, the skip link transitions over its normal, non-zero duration', async ({
    page,
  }) => {
    await page.setContent(pageHtml);
    const seconds = await transitionDurationSeconds(page);
    const expectedSeconds = Number.parseFloat(motionTokens.duration.fast) / 1000;
    expect(seconds).toBeCloseTo(expectedSeconds, 3);
    expect(seconds).toBeGreaterThan(0.05);
  });

  test('prefers-reduced-motion: reduce collapses the same transition to an effectively-zero duration', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setContent(pageHtml);
    const seconds = await transitionDurationSeconds(page);
    expect(seconds).toBeLessThan(0.001);
  });
});
