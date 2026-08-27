import { defineConfig, devices } from '@playwright/test';

// TASK 5.3.1: real-browser, real-signed-in-session a11y gate for the
// account shell, run against **production** (PRODUCTION_BASE_URL,
// account-env.ts) on a **schedule** (nightly — .github/workflows/ci.yml),
// never per-PR. Deliberately its own config, separate from
// playwright.pr-env.config.ts: that one targets a just-deployed,
// unauthenticated per-PR ephemeral stack, and mixing the two would either
// point this suite at a stack with no backend to sign into, or point that
// one at production, which the pr-environment CI job must never touch.
//
// `fullyParallel: false` and the `setup`/`chromium` project split (rather
// than a `beforeAll` per test file) are both the same decision:
// account-a11y.setup.ts signs in with the real clinician test identity
// exactly once and hands every route's own test the resulting
// `storageState`, instead of each of accountRoutes.length tests driving
// its own real Cognito sign-in — real external round trips, and a needless
// way to invite whatever adaptive-security throttling Cognito applies to
// several near-simultaneous sign-ins from one identity.
const authFile = 'test-results/.auth/clinician.json';

export default defineConfig({
  testDir: './pr-env',
  timeout: 45_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  projects: [
    {
      name: 'setup',
      testMatch: 'account-a11y.setup.ts',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testMatch: 'a11y-authenticated.test.ts',
      use: { ...devices['Desktop Chrome'], storageState: authFile },
      dependencies: ['setup'],
    },
  ],
});
