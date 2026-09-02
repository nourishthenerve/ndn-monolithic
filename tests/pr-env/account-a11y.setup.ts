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
  // A full OAuth round trip against production — redirect out to Cognito,
  // two form submissions, redirect back, then this site's own `/auth/token`
  // exchange. The config's 45s covers an axe scan of an already-loaded
  // page comfortably and covered this only just; the MFA branch below made
  // it marginal enough to be worth stating rather than leaving to chance.
  setup.setTimeout(90_000);
  const identity = getClinicianTestIdentity();

  // `GET /auth/signin` is not locale-prefixed (web-authentication.md's own
  // flow diagram), and `infra/src/config.ts`'s AUTH_CALLBACK_URL sends
  // Cognito back to a fixed `/en/account/callback` regardless of which
  // locale a caller started from — this goto's own locale has no bearing
  // on where the flow lands. `?pool=clinician` is required — found live,
  // 2026-08-28, this project's own first real run of this exact flow:
  // without it, `poolFrom()` (auth-routes.ts) defaults to the *patient*
  // pool, which is passwordless email OTP and shows no password field at
  // all — the `locator.fill` timeout this task's own first CI run hit.
  await page.goto(`${PRODUCTION_BASE_URL}/auth/signin?pool=clinician`);

  // Cognito's own managed-login page, not this repo's — `web-authentication.md`
  // states directly that "no test in this repository can reach" the OTP/
  // challenge page's own accessibility, and that holds here too: these
  // locators exist only to get a real session, not to assert anything
  // about Cognito's own UI. Accessible-role/label locators, not guessed
  // CSS selectors, both for resilience against markup Cognito can change
  // without notice.
  //
  // **Corrected against the real page, 2026-08-28 — this flow's own first
  // live run.** Two things this file's own original text assumed
  // incorrectly, both found by actually driving the page rather than
  // guessing at its shape: (1) email and password are one screen, one
  // submit — there is no separate "continue" step between them; (2) the
  // real managed-login page is a controlled React form whose submit button
  // stays disabled after Playwright's plain `.fill()` (which sets the
  // value without the per-keystroke events this form's own validation
  // watches for) — `pressSequentially` plus a `Tab` blur is what actually
  // enables it, confirmed against a live sign-in before this fix landed.
  const emailField = page.getByLabel(/email|username/i).first();
  await emailField.click();
  await emailField.pressSequentially(identity.email, { delay: 20 });
  const passwordField = page.getByLabel(/^password$/i).first();
  await passwordField.click();
  await passwordField.pressSequentially(identity.password, { delay: 20 });
  await page.keyboard.press('Tab');
  await page.getByRole('button', { name: /sign in/i }).first().click();

  // ADR-0004 had the clinician pool at password + **REQUIRED** TOTP, and
  // this step was written to match: compute a code from the stored secret
  // (no external mailbox needed, unlike the patient pool — see
  // account-env.ts) and fill the challenge.
  //
  // **That stopped being true on 2026-08-31**, when the owner relaxed the
  // pool to `Mfa.OPTIONAL` ("I don't want 2FA as of now") after the real
  // principal account was locked out of an `MFA_SETUP` challenge it could
  // not complete — see infra/src/auth-stack.ts's own amendment. An
  // identity with no enrolled device is now signed straight through to
  // the callback, so this step sat waiting 45 seconds for a field that
  // was never going to appear, and the nightly run has failed every night
  // since. It is the test that was wrong, not the pool.
  //
  // So the challenge is **probed for, not assumed**. Note what is *not*
  // relaxed: the assertion below is unchanged, and it is the one that
  // matters — the run only passes if it reaches `/en/account` with a real
  // session behind it. This makes the setup agnostic about *how* Cognito
  // got there, not about whether it did. If MFA is ever set back to
  // `REQUIRED`, the challenge simply appears again and this branch runs.
  const codeField = page.getByLabel(/enter code|code|authenticator|one-time/i).first();
  const mfaChallenged = await codeField
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);

  if (mfaChallenged) {
    const code = await generate({ secret: identity.totpSecret });
    await codeField.click();
    await codeField.pressSequentially(code, { delay: 20 });
    await page.keyboard.press('Tab');
    await page.getByRole('button', { name: /sign in|continue|submit/i }).first().click();
  }

  // SignInPanel.tsx's AuthCallback does `location.replace('/en/account')`
  // only once `/auth/token`'s exchange actually succeeds — waiting for
  // this URL is waiting for a real session, not just "Cognito redirected
  // somewhere."
  await page.waitForURL(`${PRODUCTION_BASE_URL}/en/account`, { timeout: 30_000 });
  await expect(page.getByRole('status')).toHaveCount(0, { timeout: 15_000 });

  await page.context().storageState({ path: authFile });
});
