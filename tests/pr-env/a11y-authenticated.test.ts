// TASK 5.3.1: the live-session accessibility check the account shell has
// never had. `a11y-full.test.ts` (TASK 1.1.3) scans every route in
// `routes.ts` against a fresh, unauthenticated per-PR ephemeral stack —
// every authenticated page is deliberately absent from that registry
// because it has no accessible content to find that way, named honestly
// at every account-shell task since TASK 2.2.4 (2.2.4, 3.1.1, 3.5.2,
// 3.6.2, and every Phase 4 UI task — gate-g4-report.md §7 counts six
// citations before this one closes the gap).
//
// This suite reads `account-routes.ts` instead, runs against **production**
// (never a per-PR ephemeral stack — TASK 0.6.3's own WebStack-only copy
// has no DataStack/AuthStack to authenticate against), and is wired into
// CI as a **scheduled**, not per-PR, job — see docs/runbooks/
// live-session-accessibility.md for exactly why, and for this task's own
// honestly-scoped gap: only the clinician test identity signs in today
// (account-a11y.setup.ts), because the clinician pool is password + TOTP,
// computable from a stored secret, while the patient pool is passwordless
// email OTP that no test in this repository can complete without a real
// inbox — and SES production access remains denied regardless
// (docs/runbooks/ses-production-access.md). Every route below is still
// axe-scanned, including patient-owned ones: `CaseloadView.tsx` and every
// sibling account component treat a `403` as an ordinary, expected
// outcome, so a clinician session still reaches a real, legible forbidden
// state on a patient-owned page — this run proves that state is
// accessible, not the patient's own real content, which stays unproven
// until the patient-identity gap named above closes.
import { AxeBuilder } from '@axe-core/playwright';
import { accountRoutes } from '@ndn/web/account-routes.js';
import { expect, test } from '@playwright/test';

import { getTestAppointmentId, PRODUCTION_BASE_URL } from './account-env.js';

for (const route of accountRoutes) {
  test(`${route.path} (clinician session) has no automatically-detectable axe violations`, async ({
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
          `${route.path}: A11Y_TEST_APPOINTMENT_ID is not set, so this scans the ` +
          "page's too-early/join-denied state rather than a real in-call state. " +
          'See docs/runbooks/live-session-accessibility.md.',
      });
    }
    if (route.ownerRole === 'patient') {
      test.info().annotations.push({
        type: 'wrong-role-content-unscanned',
        description:
          `${route.path}: scanned with the clinician identity only. This route's ` +
          'real, patient-owned content is not covered by this run — only its ' +
          'legible forbidden state is. See this file’s own header.',
      });
    }

    await page.goto(url);
    // RequireAuth renders a `role="status"` line while the session
    // resolves and nothing else until it does (RequireAuth.tsx) — waiting
    // for it to clear is waiting for the page's real content (or its real
    // signed-out/forbidden state) to actually be in the DOM before axe
    // scans it.
    await expect(page.getByRole('status')).toHaveCount(0, { timeout: 15_000 });

    const results = await new AxeBuilder({ page }).analyze();

    expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
  });
}
