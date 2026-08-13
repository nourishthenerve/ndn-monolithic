import { defineConfig, devices } from '@playwright/test';

// TASK 1.1.3: real-browser a11y + keyboard suite against a live, just-
// deployed ephemeral PR stack (PR_ENV_BASE_URL — see pr-env/env.ts).
// Separate from vitest.pr-env.config.ts because axe-core's color-contrast/
// visibility checks and real keyboard focus/event dispatch need an actual
// browser, not jsdom — the exact limitation pr-env/a11y.test.ts's own
// comment (TASK 0.6.3) documented and this task supersedes it to fix.
//
// `testMatch` is scoped to exactly the files that import Playwright's own
// test/expect: vitest.pr-env.config.ts's `pr-env/**/*.test.ts` glob is
// broader and already owns contract.test.ts/integration.test.ts, which
// import `vitest`'s describe/it/expect, not Playwright's — letting this
// config pick those up too would fail immediately on the wrong test API.
// TASK 1.2.3 added cookie-consent.test.ts to this same Playwright-only set.
export default defineConfig({
  testDir: './pr-env',
  testMatch: ['a11y-full.test.ts', 'keyboard.test.ts', 'cookie-consent.test.ts'],
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
