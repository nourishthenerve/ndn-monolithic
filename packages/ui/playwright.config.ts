import { defineConfig, devices } from '@playwright/test';

// TASK 1.1.1: real-browser proof that reduced-motion actually collapses a
// transition — jsdom (used by every other test in this package) doesn't
// implement `prefers-reduced-motion` media evaluation reliably (confirmed
// empirically while building Button.test.tsx). Every spec under `e2e/`
// uses `page.setContent()` with inline HTML built from this package's own
// exported CSS strings, so there is no dev server/deployed URL dependency.
export default defineConfig({
  testDir: './e2e',
  timeout: 15_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
