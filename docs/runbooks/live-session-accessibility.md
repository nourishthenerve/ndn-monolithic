# The live-session accessibility check the account shell has never had (TASK 5.3.1)

**Date:** 2026-08-27 · **Task:** [05-execution-plan.md § TASK 5.3.1](../plan/05-execution-plan.md) · **Requirements:** FR-X-02 · **Depends on:** 4.5.1

## Status: mechanism built, live run not yet executed

This task's route registry, Playwright spec, sign-in setup project and scheduled CI job are built and verified by `pnpm -r lint`/`pnpm -r typecheck`/a unit test on the registry itself. **No real scheduled run has ever executed** — the account owner's own go-ahead this turn covered building the mechanism, not creating real Cognito test identities, adding real GitHub secrets, or triggering the new workflow, all of which are real, production-affecting actions requiring their own explicit approval, the identical deferral `docs/runbooks/load-testing.md` recorded for TASK 5.1.1's live run. TASK 5.3.1's own DoD in `05-execution-plan.md` — "every authenticated account-shell page is axe-scanned in a real, signed-in, rendered session **at least once per day**" — is therefore not yet met by this PR alone.

## The gap this closes

Named six times before this task, each citation honestly identical: `tests/pr-env/a11y-full.test.ts` (TASK 1.1.3) scans every route in `routes.ts` against a fresh, unauthenticated per-PR ephemeral stack, and every authenticated account-shell page is deliberately absent from that registry because it has no accessible content to find that way — TASK 2.2.4's sign-in flow, TASK 3.1.1's patient profile ([patient-record.md](patient-record.md), also covering TASK 3.2.x's clinical-record timeline, [clinical-record.md](clinical-record.md)), TASK 3.5.2's "my content" page ([content-assignment.md](content-assignment.md)), TASK 3.6.2's message thread ([messaging.md](messaging.md)), and every Phase 4 video-calling UI task ([video-calls.md](video-calls.md)) all stated the same thing: construction-time accessibility (semantic HTML, ARIA roles, keyboard reachability) is real coverage, a live-rendered-DOM axe scan against a real session is not, because no mechanism existed to drive one. Gate G4's own §7 counted the sixth citation and named this the task that finally closes it (`gate-g4-report.md`).

## Why this can't extend the existing per-PR mechanism

TASK 0.6.3's ephemeral stack deploys `WebStack` alone — no `DataStack`, no `AuthStack` (`infra/bin/app.ts`: "DataStack's resources aren't behind the PR-environment integration/a11y suite today"). An authenticated page in a PR environment has no real API or Cognito pool to sign into. A live-session check needs a real signed-in session, which means running against **production** (or, per TASK 5.1.1's own precedent, a full-stack disposable copy — not built here; production is what this task uses, since the check itself creates no destructive or unbounded-cost state). This is why the new suite is wired into CI as a **scheduled**, nightly job, never a per-PR one: a live time-boxed appointment window and production's own flag state make gating it to arbitrary PR-merge timing flaky in a way the existing per-PR gate never has to tolerate.

## What was built

### `apps/web/src/account-routes.ts` — the authenticated counterpart to `routes.ts`

Mirrors `routes.ts`'s own shape (locale × segment, a `''` segment meaning the bare `/account` page) for exactly the pages `routes.ts` deliberately excludes: `account` (index), `account/patient`, `account/caseload`, `account/content`, `account/messages`, `account/call`. Each entry carries an `ownerRole` (`'patient' | 'clinician' | 'either'`) — not an access gate, since every account component (`CaseloadView.tsx`, `AssignedContent.tsx`, `PatientProfile.tsx`, `MessageThread.tsx`) already treats a `403` from the "wrong" role as an ordinary, expected outcome rather than an error, per each one's own header comment — but a note of whose real content actually renders there, so the a11y spec can annotate a scan that only reached a forbidden state rather than silently reporting it as full coverage. `call`'s own entry carries `needsAppointmentId: true`, since its real content needs a live, in-window appointment id in the query string, not only a session.

`account/callback.astro` is deliberately not registered — see the file's own header comment: nobody signed in ever navigates there on purpose, and visiting it with no `?code=` reaches a state no real session produces, the same reasoning `routes.ts` already applies to excluding `blog/[slug]`/`workshops/[slug]`.

Exported via `apps/web/package.json`'s `./account-routes.js`, alongside `./routes.js`. Unit-tested (`account-routes.test.ts`): every path is locale-prefixed and unique, only `call` carries `needsAppointmentId`, `callback` never appears.

### `tests/pr-env/account-a11y.setup.ts` + `playwright.account-a11y.config.ts` — one real sign-in, shared

A Playwright "setup" project signs in once, for real, as the clinician test identity, and hands the resulting `storageState` (cookies, including the `HttpOnly` refresh cookie — Playwright's `storageState` captures it at the browser/CDP level, the same layer `web-authentication.md`'s own design already assumes script cannot reach) to a dependent `chromium` project that runs every route's own test. `fullyParallel: false`: one shared session, not `accountRoutes.length` separate real Cognito sign-ins racing each other and each computing a TOTP code in quick succession — wasteful against a real external service and a needless way to invite whatever adaptive-security throttling Cognito applies to several near-simultaneous sign-ins from one identity.

The sign-in flow itself (`GET /auth/signin` → Cognito's managed-login page → `/en/account/callback` → `/en/account`) uses accessible-role/label Playwright locators (`getByLabel(/email|username/i)`, `getByRole('button', ...)`, etc.) rather than guessed CSS selectors, both for resilience against markup Cognito can change without notice and because **no test in this repository has ever driven this page live before** — the first real scheduled run is also this flow's own selector verification, named honestly here rather than claimed proven ahead of it, the same "MECHANISM COMPLETE, UNVERIFIED LIVE" shape Gate G4 used for TASK 4.4.1's TURN credential path.

### `tests/pr-env/a11y-authenticated.test.ts` — the scan itself

Same shape as `a11y-full.test.ts` (TASK 1.1.3): one test per `account-routes.ts` entry, `page.goto`, wait for `RequireAuth`'s own `role="status"` line to clear (real content — or a real signed-out/forbidden state — is now actually in the DOM, not merely resolving), then `AxeBuilder(...).analyze()`, asserting zero violations. Two annotations, matching `keyboard.test.ts`'s own `no-visible-button` precedent for naming a legitimate reduced state rather than silently passing it as full coverage: a `call` scan with no `A11Y_TEST_APPOINTMENT_ID` set names that it covers the too-early/join-denied state, not a real in-call one; a `patient`-owned route scanned by the clinician identity names that only its forbidden state is covered.

### `tests/pr-env/account-env.ts` — env plumbing, fail loud

`getClinicianTestIdentity()` reads `A11Y_CLINICIAN_EMAIL`/`A11Y_CLINICIAN_PASSWORD`/`A11Y_CLINICIAN_TOTP_SECRET` and throws immediately, by name, if any is unset — `env.ts`'s own `getBaseUrl()` precedent (TASK 0.6.3). `getPatientTestIdentity()` and `getTestAppointmentId()` return `undefined` instead, by design (see "The patient-identity gap" below and the `call` fixture note above) — a missing patient identity or appointment fixture is a named, expected state today, not a hard failure.

### `otplib` — a new devDependency, justified here rather than assumed

The clinician test identity's TOTP code is computed with `otplib`'s `generate({ secret })` (v13's tree-shakeable API — no `authenticator` singleton, confirmed against the installed version rather than assumed from older docs). No native build script (`npm view otplib scripts` — none of `preinstall`/`install`/`postinstall`), so no `pnpm-workspace.yaml` `allowBuilds` entry was needed, unlike TASK 5.1.1's `artillery` addition.

### `.github/workflows/ci.yml` — a new scheduled job, separate from `pr-environment`

*(Owner action still required before this job can turn green — see below. The workflow definition itself is complete.)*

## The patient-identity gap — named, not built

Only the **clinician** test identity signs in today. This is not an oversight left for later; it is the honest boundary of what's automatable without a new piece of infrastructure this task's own Files list does not include:

- The clinician pool (`ndn-clinicians`) is password + `REQUIRED` TOTP (D-09, ADR-0004) — a TOTP code is deterministic from a stored secret, computable client-side with no external service in the loop.
- The patient pool (`ndn-patients`) is passwordless email OTP, no password (ADR-0004). Cognito delivers that code only by real email; there is no admin API that returns it. Completing this flow in an automated test needs a real inbox a test can read — an IMAP-pollable mailbox or equivalent — which does not exist in this codebase today.
- Independent of the above, **SES production access remains denied** ([ses-production-access.md](ses-production-access.md), denied 2026-08-21) — the same blocker `web-authentication.md`'s own Verification section and [patient-registration.md](patient-registration.md) already name for the browser sign-in check neither task has been able to run live. A patient test identity could not receive a real email OTP in production even if a mailbox-reading fixture existed.

Every route is still scanned today, including patient-owned ones (`account/patient`, `account/content`) — the clinician identity reaches them and gets a real, legible, accessible forbidden state, which this suite proves is accessible. What stays unproven is the patient's own real rendered content on those pages, honestly named in each scan's own annotation (see above) rather than silently claimed covered.

**Do NOT** treat a clean nightly run as proof that patient-owned content is accessible — it proves the forbidden-state branch is, and nothing about the branch a patient would actually see.

## What is still needed before a live run — owner action / separate go-ahead

None of this was executed. In order, whenever authorised:

1. **Two real, permanent, clearly-labelled test identities** — the same fixture `docs/runbooks/load-testing.md` names needing, built once and shared, not twice differently:
   - **Clinician**, in `ndn-clinicians`: `AdminCreateUser` with a permanent password (`AdminSetUserPassword --permanent`), then complete TOTP enrolment (`AssociateSoftwareToken` / `VerifySoftwareToken` against a real sign-in) and **record the base32 secret at enrolment time** — Cognito never returns it again afterward. Named unambiguously (e.g. `test.clinician+ndn@…`) and excluded from any real notification/marketing path.
   - **Patient**, in `ndn-patients` — needed by TASK 5.1.1's own load-test scenario too, not only this task; building it does not by itself close the patient-identity gap above, which additionally needs a mailbox-reading fixture and SES production access.
2. **Three GitHub Actions secrets**: `A11Y_CLINICIAN_EMAIL`, `A11Y_CLINICIAN_PASSWORD`, `A11Y_CLINICIAN_TOTP_SECRET`.
3. **A rolling test appointment** kept inside `call.astro`'s own join window (a small scheduled job, or a fixture created and cancelled per run) — without it, `call`'s own scan covers only its too-early/join-denied state, named honestly by the spec's own annotation rather than silently treated as full coverage. Set `A11Y_TEST_APPOINTMENT_ID` once it exists.
4. Confirm the first scheduled run is green — `pnpm run test:account-a11y` locally against production (with the three secrets exported) reproduces exactly what the scheduled job runs.
5. Only once the mailbox-reading fixture and SES production access both exist: add a patient identity to `account-env.ts`'s `getPatientTestIdentity()` path and extend the setup project to sign in as both identities, closing the gap named above for real.

## Cost

Negligible — reuses existing Cognito/API infrastructure; no new AWS resource beyond the two test-principal records named above (already needed by TASK 5.1.1 regardless) and, if step 3's fixture is built as a scheduled Lambda rather than an ad hoc script, one more low-volume invocation per day, inside every existing Lambda's own free-tier headroom.
