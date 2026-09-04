# The live-session accessibility check the account shell has never had (TASK 5.3.1, TASK 5.3.2)

**Date:** 2026-08-27, updated 2026-08-28 · **Task:** [05-execution-plan.md § TASK 5.3.1](../plan/05-execution-plan.md), [§ TASK 5.3.2](../plan/05-execution-plan.md) · **Requirements:** FR-X-02 · **Depends on:** 4.5.1

## Status: live, scheduled, and green — both tasks' DoD met

The account owner provisioned the real sub-clinician test identity and its three GitHub secrets on 2026-08-28 and manually triggered the first real run. That run found two bugs in the sign-in setup itself (`?pool=clinician` missing; `.fill()` not driving the real managed-login form's own validation — [PR #113](https://github.com/nourishthenerve/ndn-monolithic/pull/113)) sitting behind four other production bugs the sign-in flow surfaced along the way (CSP blocking account-shell hydration, Cognito managed-login branding, CloudFront stripping auth headers, the clinician-directory key mismatch — [#109](https://github.com/nourishthenerve/ndn-monolithic/pull/109)–[#112](https://github.com/nourishthenerve/ndn-monolithic/pull/112)). With all five fixed, the scheduled `account-a11y` job (`.github/workflows/ci.yml`) has run green via `workflow_dispatch`: **zero axe violations across every registered route** — TASK 5.3.2's own axe half needed no remediation once the run could actually complete.

TASK 5.3.2's own step 4 (a keyboard-completeness pass, extended to the authenticated set for the first time) was still missing after that — `keyboard.test.ts` (TASK 1.1.3) has only ever walked `routes.ts`'s public set. `tests/pr-env/keyboard-authenticated.test.ts` closes it: the same skip-link/tab-order/no-trap/Enter-Space walk, ported to `account-routes.ts`, sharing the `chromium` project's one real sign-in with `a11y-authenticated.test.ts` rather than a second one (`playwright.account-a11y.config.ts`). One deliberate difference from the public suite: the injected click listener also calls `preventDefault()`/`stopPropagation()` before React's own delegated handler sees the event, because a real button here can carry a real side effect against production — the nav's own `SignOutButton` really revokes the session and navigates, `messages`'s composer really submits — neither of which may fire just to prove Enter/Space dispatches a click. (Since 2026-09-04 that sign-out is in the site header rather than at the foot of each account page, so it is on *every* page the suite walks, not one — which makes this guard load-bearing on all of them rather than on `account` alone.) Verified live via `workflow_dispatch` on the branch that added it, before merge: green, zero findings, no remediation needed.

**Both tasks' DoD are now met:** TASK 5.3.1's "axe-scanned in a real, signed-in, rendered session at least once per day" (the schedule trigger — `cron: '0 3 * * *'` — has not yet fired on its own timer since this was verified only via manual `workflow_dispatch`, but the mechanism it will run is proven). TASK 5.3.2's "every authenticated page passes the live-session check with zero axe violations and is fully keyboard-operable" — both true today, for the clinician identity's own real content and every route's real or forbidden state alike (see the patient-identity gap below, unchanged by either task).

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

### `tests/pr-env/keyboard-authenticated.test.ts` — TASK 5.3.2's own addition

Same shape as `keyboard.test.ts` (TASK 1.1.3), ported to `account-routes.ts` and joined into the same signed-in `chromium` project as `a11y-authenticated.test.ts` (`playwright.account-a11y.config.ts`'s `testMatch` array) rather than a second sign-in project. No third-party-widget handling — the only such region in this codebase, the contact form's Turnstile widget, is on no account-shell page. The one real behavioural difference from the public suite: the injected click listener calls `preventDefault()`/`stopPropagation()` on the button itself, ahead of React's own delegated handler, so proving Enter/Space dispatches a click never also fires the button's real handler — the nav's own `SignOutButton` really revokes the session and navigates — and since 2026-09-04 it is in the site header, so it is present on every page the suite walks rather than only on `account`; `messages`'s composer really submits a message between a real patient and clinician. Verified live via `workflow_dispatch` on its own branch before merge: green, zero findings.

### `.github/workflows/ci.yml` — a new scheduled job, separate from `pr-environment`

Green via manual `workflow_dispatch` (2026-08-28, after [#113](https://github.com/nourishthenerve/ndn-monolithic/pull/113) and again after this task's own keyboard suite) — see Status above. The `cron: '0 3 * * *'` schedule itself has not yet fired unattended; nothing about a manual trigger differs from what that schedule will run.

## The patient-identity gap — named, not built

Only the **clinician** test identity signs in today. This is not an oversight left for later; it is the honest boundary of what's automatable without a new piece of infrastructure this task's own Files list does not include:

- The clinician pool (`ndn-clinicians`) is password + `REQUIRED` TOTP (D-09, ADR-0004) — a TOTP code is deterministic from a stored secret, computable client-side with no external service in the loop.
- The patient pool (`ndn-patients`) is passwordless email OTP, no password (ADR-0004). Cognito delivers that code only by real email; there is no admin API that returns it. Completing this flow in an automated test needs a real inbox a test can read — an IMAP-pollable mailbox or equivalent — which does not exist in this codebase today.
- Independent of the above, **SES production access remains denied** ([ses-production-access.md](ses-production-access.md), denied 2026-08-21) — the same blocker `web-authentication.md`'s own Verification section and [patient-registration.md](patient-registration.md) already name for the browser sign-in check neither task has been able to run live. A patient test identity could not receive a real email OTP in production even if a mailbox-reading fixture existed.

Every route is still scanned today, including patient-owned ones (`account/patient`, `account/content`) — the clinician identity reaches them and gets a real, legible, accessible forbidden state, which this suite proves is accessible. What stays unproven is the patient's own real rendered content on those pages, honestly named in each scan's own annotation (see above) rather than silently claimed covered.

**Do NOT** treat a clean nightly run as proof that patient-owned content is accessible — it proves the forbidden-state branch is, and nothing about the branch a patient would actually see.

## What is still needed — owner action / separate go-ahead

Items 1, 2 and 4 below are done (2026-08-28). What's left is genuinely separate scope, not this task's own DoD: TASK 5.3.1/5.3.2's DoD names neither an appointment fixture nor a patient identity, and both remain honestly named as open rather than silently assumed:

1. ~~Two real, permanent, clearly-labelled test identities~~ — the **clinician** identity exists in `ndn-clinicians`, enrolled and in use. The **patient** identity (also needed by TASK 5.1.1's own load-test scenario) is not built; building it would not by itself close the patient-identity gap below, which additionally needs a mailbox-reading fixture and SES production access.
2. ~~Three GitHub Actions secrets~~ — `A11Y_CLINICIAN_EMAIL`, `A11Y_CLINICIAN_PASSWORD`, `A11Y_CLINICIAN_TOTP_SECRET` are set and in use by the scheduled job.
3. **A rolling test appointment** kept inside `call.astro`'s own join window (a small scheduled job, or a fixture created and cancelled per run) — without it, `call`'s own scan covers only its too-early/join-denied state, named honestly by both specs' own annotation rather than silently treated as full coverage. Set `A11Y_TEST_APPOINTMENT_ID` once it exists.
4. ~~Confirm the first scheduled run is green~~ — done via `workflow_dispatch`, both for the axe scan and, separately, for the keyboard-completeness suite (Status above). The `cron` schedule's own first unattended firing has not yet been observed.
5. Only once the mailbox-reading fixture and SES production access both exist: add a patient identity to `account-env.ts`'s `getPatientTestIdentity()` path and extend the setup project to sign in as both identities, closing the patient-identity gap for real.

## Cost

Negligible — reuses existing Cognito/API infrastructure; no new AWS resource beyond the two test-principal records named above (already needed by TASK 5.1.1 regardless) and, if step 3's fixture is built as a scheduled Lambda rather than an ad hoc script, one more low-volume invocation per day, inside every existing Lambda's own free-tier headroom.

## Coverage lost, 2026-08-31, and why it is not recoverable

The three principal-only pages — `/account/caseload`, `/account/patient-admin`, `/account/clinician-admin` — now decide client-side whether to render their content at all, instead of rendering a form and letting the submit be refused. The owner's own words, on seeing the create-clinician form offered to a sub-clinician: *"for a non-principal clinician I dont even want create patient or create clinician account to be visible. Atm it says at the very end that you dont have permission to create the account."*

That is a real improvement to the product and a real loss to this suite. The clinician identity this suite signs in as is a **sub-clinician** fixture, so from today those three routes are axe-scanned in their *forbidden* state — a legible state worth scanning, and exactly what `account-routes.ts`'s own `ownerRole` doc already anticipated — but their real content is scanned by nothing.

**It cannot be fixed by adding a principal fixture.** Exactly one principal clinician may exist, enforced transactionally (`clinician-repository.ts`'s singleton marker row), so a principal test identity would have to *be* the owner's own live account, with its real password in CI secrets. That is not a trade worth making for an axe scan on three pages.

What remains true of those pages' accessibility is what was true before this suite existed: semantic HTML by construction — real `<table>`/`<caption>`/`scope="col"`, `role="status"`/`role="alert"` regions, real `<button>`s disabled rather than hidden, and every form control carrying its own label or `aria-label`. Verified by review, not by axe. Stated here rather than left to be discovered.

## Amendment, 2026-09-02 — the nightly run had been failing for three nights, for two unrelated reasons

Both were found together and neither was caused by the change that happened to be merging at the time.

### 1. The sign-in setup assumed MFA it no longer gets

`account-a11y.setup.ts` was written when the clinician pool was `Mfa.REQUIRED`, so after submitting the password it went straight to filling a TOTP challenge. **On 2026-08-31 the owner relaxed the pool to `Mfa.OPTIONAL`** — "I don't want 2FA as of now" — applied directly against the live pool after the real principal account was locked out of an `MFA_SETUP` challenge it could not complete (`infra/src/auth-stack.ts`'s own amendment).

An identity with no enrolled device is now signed straight through to the callback. The setup sat waiting for a field that would never appear, timed out at 45 seconds, and every nightly run since has failed at the same line — the test was wrong, not the pool.

The challenge is now **probed for** rather than assumed. What is deliberately *not* relaxed: the assertion that the run reaches `/en/account` with a real session is unchanged, and it is the one that proves sign-in worked. The setup is now agnostic about *how* Cognito got there, not about whether it did — and if MFA ever goes back to `REQUIRED`, the challenge simply reappears and that branch runs again.

The setup also gets its own 90-second timeout. The config's 45s is sized for an axe scan of a loaded page; this test does a full OAuth round trip against production, and it was already close.

### 2. The nightly run was cancelling production deploys

Worse, and completely separate. A scheduled run and a push to `main` both have `github.ref == refs/heads/main`, so they shared the workflow-level concurrency group — and `cancel-in-progress: true` meant the 07:23 nightly cancelled the still-running deploy from the merge of PR #162 fourteen seconds later, eight minutes into `cdk deploy`.

**The merge showed green and the production stack never received the change.** The only trace was "The operation was canceled" inside a job nobody re-reads after a merge has gone in.

The `account-a11y` job already carried its own concurrency group with this exact scenario in its comment — *"or this job cancel a push's own deploy"*. That override was necessary but not sufficient: a job-level group decides which jobs queue against each other, while the workflow-level key cancels a whole in-progress **run**, and a cancelled run takes every job in it whatever group those jobs named. The trigger is now part of the workflow-level group.

**If a nightly failure ever coincides with a merge, check the deploy job before assuming the two are related.** They were not, and the deploy was the one that mattered.
