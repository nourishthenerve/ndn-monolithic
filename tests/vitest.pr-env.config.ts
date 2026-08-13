import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['pr-env/**/*.test.ts'],
    // TASK 1.1.3: a11y-full.test.ts/keyboard.test.ts import `test`/`expect`
    // from `@playwright/test`, not vitest — calling Playwright's `test()`
    // outside Playwright's own runner throws immediately ("Playwright Test
    // did not expect test() to be called here"), confirmed failing in CI.
    // playwright.pr-env.config.ts's own `testMatch` already scopes the
    // reverse direction (it owns exactly these files); this exclude is the
    // other half of that split. TASK 1.2.3 added cookie-consent.test.ts to
    // the same Playwright-only set.
    exclude: [
      'pr-env/a11y-full.test.ts',
      'pr-env/keyboard.test.ts',
      'pr-env/cookie-consent.test.ts',
    ],
    // TASK 0.6.3: this suite hits a real, just-deployed ephemeral stack
    // (see tests/pr-env/env.ts) — a CloudFront/Lambda cold start plus a
    // couple of round trips comfortably exceeds vitest's 5s default.
    testTimeout: 30_000,
  },
});
