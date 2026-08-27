// TASK 5.3.1: a Playwright "setup" project (playwright.account-a11y.config.ts's
// own `dependencies: ['setup']`) rather than a `beforeAll` inside the spec
// file — this drives one real Cognito sign-in, once, and hands every
// route's own test a already-authenticated browser context via
// `storageState`. Signing in fresh per route would mean N real Cognito
// round trips (one per registered route, growing every time a page is
// added) computing N separate TOTP codes in quick succession — wasteful
// against a real external service, and a needless way to invite the
// adaptive-security throttling Cognito can apply to rapid repeated
// sign-ins from one identity. `playwright.account-a11y.config.ts` also
// turns `fullyParallel` off for the same reason this file exists: one
// shared session, not a race between several.
import { expect, test as setup } from '@playwright/test';
import { generate } from 'otplib';

import { getClinicianTestIdentity, PRODUCTION_BASE_URL } from './account-env.js';

const authFile = 'test-results/.auth/clinician.json';

setup('sign in as the clinician test identity', async ({ page }) => {
  const identity = getClinicianTestIdentity();

  // `GET /auth/signin` is not locale-prefixed (web-authentication.md's own
  // flow diagram), and `infra/src/config.ts`'s AUTH_CALLBACK_URL sends
  // Cognito back to a fixed `/en/account/callback` regardless of which
  // locale a caller started from — this goto's own locale has no bearing
  // on where the flow lands.
  await page.goto(`${PRODUCTION_BASE_URL}/auth/signin`);

  // Cognito's own managed-login page, not this repo's — `web-authentication.md`
  // states directly that "no test in this repository can reach" the OTP/
  // challenge page's own accessibility, and that holds here too: these
  // locators exist only to get a real session, not to assert anything
  // about Cognito's own UI. Accessible-role/label locators, not guessed
  // CSS selectors, both for resilience against markup Cognito can change
  // without notice and because no test in this repo has ever driven this
  // page live before — the first scheduled run is this flow's own
  // selector verification, named honestly in the runbook rather than
  // claimed proven ahead of it.
  await page
    .getByLabel(/email|username/i)
    .first()
    .fill(identity.email);
  await page
    .getByRole('button', { name: /continue|next|sign in/i })
    .first()
    .click();

  await page
    .getByLabel(/password/i)
    .first()
    .fill(identity.password);
  await page
    .getByRole('button', { name: /continue|sign in|submit/i })
    .first()
    .click();

  // ADR-0004: the clinician pool is password + REQUIRED TOTP, never email
  // OTP — computable from a stored secret with no external mailbox,
  // unlike the patient pool (see account-env.ts's own comment on why only
  // this identity is wired up today).
  const code = await generate({ secret: identity.totpSecret });
  await page
    .getByLabel(/code|authenticator|one-time/i)
    .first()
    .fill(code);
  await page
    .getByRole('button', { name: /continue|sign in|submit/i })
    .first()
    .click();

  // SignInPanel.tsx's AuthCallback does `location.replace('/en/account')`
  // only once `/auth/token`'s exchange actually succeeds — waiting for
  // this URL is waiting for a real session, not just "Cognito redirected
  // somewhere."
  await page.waitForURL(`${PRODUCTION_BASE_URL}/en/account`, { timeout: 30_000 });
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 15_000 });

  await page.context().storageState({ path: authFile });
});
