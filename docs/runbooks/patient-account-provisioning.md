# Staff-mediated patient account creation and password reset, over WhatsApp (D-29)

**Date:** 2026-08-29 · **Decision:** [D-29](../plan/01-decisions.md) · **Requirements:** §5 · **Risks:** R-04, and a new one this task adds (below) · **Depends on:** 2.1.1 (RBAC), 2.2.1 (the patient pool), 2.5.1 (approval) · **Supersedes:** [patient-registration.md](patient-registration.md) (TASK 2.2.3)

## The invariant

> A patient never creates or recovers their own account. A human, reachable on the clinic's WhatsApp Business number, verifies who they are and does it on their behalf. The account grants nothing until a clinician approves it — that step is unchanged. No path deletes a person, and no path emails or texts a patient's password anywhere automatically.

## Why this exists: the pivot, in one paragraph

TASK 2.2.3 built self-registration with passwordless email-OTP sign-in (D-09). The owner's own review of that design, live, found it wrong for the actual business: the clinic's real clients are in India, where SMS OTP needs TRAI/DLT entity and template registration before a single message can send, WhatsApp OTP carries its own Meta Business verification and template-approval requirements, and email-OTP sign-in was blocked end-to-end by SES production access being denied. Rather than solve a regulatory problem that mostly exists to protect a purely-technical channel, the owner chose to remove the channel: **there is already a human answering the clinic's WhatsApp for other reasons, and that human can create accounts and hand out passwords directly, with no OTP, no SMS provider, no email deliverability dependency, and no separate compliance track.** Explicitly "no serious automation" — a human is always in the loop for creation, recovery and anything else a patient needs help with.

## What WhatsApp Business is here, and what it is not

**It is a phone number a human answers, published on the website.** It is not a technical integration this codebase calls, sends to, or receives from. No WhatsApp Business API client, no Meta app, no webhook, no template registration exists anywhere in this repository, and none is planned by this task. The "integration point" between WhatsApp and this system is a human: staff read a conversation, then call `POST /patients` or `POST /patients/{id}/reset-password` themselves (today, directly — see "Not built yet" below) and relay the result back over the same conversation.

## The flow, end to end

```text
Patient ──WhatsApp──▶ staff (human, verifies identity — training, not code)
                          │
                          ▼
            staff ──POST /patients──▶ PatientAdminFunction
                          ├─ flag: patients.administration.enabled (default OFF)
                          ├─ can(principal, 'create', 'patient-profile') — Principal only
                          ├─ AdminCreateUser (MessageAction: SUPPRESS — no Cognito email/SMS)
                          ├─ generatePassword() — 16 chars, all four policy classes, no ambiguous glyphs
                          ├─ AdminSetUserPassword (Permanent: true — no forced first-login change)
                          └─ PatientRepository.register(...) — PAT#<sub>/PROFILE, account_status: pending
                                                                                  │
                          ◀── 201 { item, password } ──────────────────────────────┘
                          │
Patient ◀──WhatsApp── staff relays the password (once; never logged, never stored by this system)
                          │
        … later, a principal clinician approves or declines, exactly as before (assignment.ts) …
                          │
Patient ──forgets password, WhatsApp again──▶ staff
                          │
            staff ──POST /patients/{id}/reset-password──▶ PatientAdminFunction
                          ├─ can(principal, 'reset-password', 'patient-profile') — Principal only
                          ├─ AdminSetUserPassword (Permanent: true)
                          └─ one audit row (action: 'reset-password') — no profile field changes
                          ◀── 200 { password } ──
                          │
Patient ◀──WhatsApp── staff relays the new password
```

## The approval step is completely unchanged

**This is the one thing the owner was explicit about keeping, and it was not touched.** `POST /patients` writes `account_status: 'pending'` through the exact same `PatientRepository.register()` method TASK 2.2.3's Post-Confirmation trigger used to call — this task's whole implementation strategy was to swap out *how a `pending` record comes to exist* without touching what happens to one afterwards. `assignment.ts`'s `POST /patients/{id}/approve`/`decline` are untouched, byte for byte. A staff-created account is exactly as unusable, until a clinician approves it, as a self-registered one always was — see `docs/plan/04-data-model-rbac.md`'s own note on why `Patient profile`'s new `create`/`reset-password` cells are deliberately not reused from `Patient assignment`'s existing `create`: conflating account creation with the approval decision would let creating an account also approve it.

## Why two new RBAC actions, not one wider `update`

`docs/plan/04-data-model-rbac.md`'s `Patient profile` row gains `create` (account creation) and a new action, `reset-password`, both `Principal`-only — the same scoping `Clinician accounts` already uses for clinician provisioning, not extended to the assigned sub-clinician. `reset-password` is its own action, not folded into `update`, for a concrete reason: **a password reset touches no field of the `PAT#` record at all.** It is a pure Cognito directory operation. Auditing it as a generic `update` would either invent a fake profile-field change to attach the audit row to, or skip auditing a credential handout entirely — neither acceptable on a system this deliberate about "who did what, when." `audit.ts`'s `AUDIT_ACTIONS` vocabulary gained `'reset-password'` for exactly this, alongside `'join'`/`'join-denied'` (TASK 4.2.1) as the only other audited actions that are not themselves a record mutation.

**Principal-only, not extended to the assigned sub-clinician, deliberately.** Creating or recovering a patient's own login credential is an identity-verification act, not a care-coordination one — a sub-clinician's job is clinical, not administrative account custody. This can be loosened later with a one-line matrix change if the real WhatsApp staffing model turns out to need it; it was not assumed here.

## The password: generated, permanent, relayed once

`services/api/src/password-generator.ts` — 16 characters, guaranteed at least one lowercase, one uppercase, one digit and one symbol (satisfying the patient pool's password policy, identical to the clinician pool's), drawn from `node:crypto`'s `randomInt` (a CSPRNG, not `Math.random()`), with visually ambiguous characters (`0`/`O`, `1`/`l`/`I`) excluded — this password is read aloud or typed by one human relaying it to another over WhatsApp, and that pair is exactly where a typo turns into a locked-out patient and a second round trip.

**`Permanent: true`, never a temporary/force-change password.** The owner's own words: "they won't have option to set their own password." A temporary password would leave a patient at Cognito's `NEW_PASSWORD_REQUIRED` challenge, which this pool's app client (`ALLOW_USER_SRP_AUTH` only, no custom-auth handling) has no self-service step to resolve — a dead end, not a smaller feature.

**Returned once, in the API response body, and nowhere else.** It is never written to DynamoDB, never included in a log line (`patient-admin.ts`'s handler logs only route/status/duration, the same shape every other handler in this codebase uses), and Cognito itself never emails or texts it (`MessageAction: SUPPRESS` on `AdminCreateUser` — see `patient-admin-handler.ts`'s own header). The only record of it, ever, is the WhatsApp conversation staff relay it through — a conversation this codebase has no visibility into and does not attempt to.

## The Cognito pool changes this required

`infra/src/auth-stack.ts`'s own header amendment has the full, precise reasoning; in brief:

| | Before (TASK 2.2.3) | After (D-29) |
|---|---|---|
| `selfSignUpEnabled` | `true` | `false` |
| First factor | Email OTP, choice-based (`ALLOW_USER_AUTH`) | Password over SRP (`ALLOW_USER_SRP_AUTH`) |
| `signInPolicy` | `['PASSWORD', 'EMAIL_OTP']` (Cognito requires `PASSWORD` in the list regardless) | `['PASSWORD']`, **explicitly** — not omitted; see "A live finding" below |
| `passwordPolicy` | none | identical to the clinician pool's |
| `accountRecovery` | `EMAIL_ONLY` | `NONE` (`admin_only`) |
| Post-Confirmation trigger | `post-confirmation.ts`, wired | deleted outright — no `ConfirmSignUp` event can fire |

**`accountRecovery: NONE` is the one change that is not merely symmetric with the clinician pool — it is load-bearing.** `ForgotPassword`/`ConfirmForgotPassword` are unauthenticated Cognito APIs, independent of which `ExplicitAuthFlows` an app client carries. Leaving `EMAIL_ONLY` in place — even with self sign-up off and the trigger deleted — would have let anyone who knew or guessed a patient's email address self-serve a password reset entirely outside the WhatsApp-verified process this whole design exists to enforce. Found and closed before any code shipped, not after.

The email attribute itself is untouched — still required, still mutable, still the pool's only attribute. Changing a pool's required attributes needs recreating it, which this change has no reason to force; staff still collect an address during WhatsApp intake (for the `personal{}` record, not for anything Cognito uses) and it is still set on the Cognito user.

## A live finding: an omitted `SignInPolicy` is not a cleared one

The first production deploy of this change (2026-08-29, same day) surfaced a real `UpdateUserPool` behaviour worth recording precisely, because a synth-only test suite cannot catch it: **`describe-user-pool` against the live `ndn-patients` pool, immediately post-deploy, still showed `AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]`** — the exact value TASK 2.2.1 originally set — even though `PasswordPolicy` (added by the same deploy, in the same `Policies` object) applied correctly, and even though CloudFormation's own template for the stack showed `SignInPolicy` simply absent.

**Root cause:** removing a property from a CDK template removes it from the CloudFormation template and from the `UpdateUserPool` API call CloudFormation issues — but Cognito's own `Policies.SignInPolicy` sub-field does not reset to a default when it is absent from an update; it is left exactly as it was. CloudFormation, having received a success response, has no way to know its own belief about the resource's state has diverged from reality — this is drift CloudFormation itself cannot detect, because its own template genuinely matches what it *asked for*, not what Cognito actually *did*.

**Not a security incident, because the app client's own `ExplicitAuthFlows` closed the door regardless** — `ALLOW_USER_AUTH` (the only flow through which `EMAIL_OTP` is reachable at all) was correctly removed the same deploy, so nothing could reach the stale pool-level allowance through the one client that exists. The same "the client is the real boundary, not the pool policy" property `docs/runbooks/cognito-user-pools.md` already documented for the *original* `[PASSWORD, EMAIL_OTP]` design held here too, by luck of the design rather than by this fix.

**Fixed by setting an explicit, narrower value rather than omitting the field**: `signInPolicy: { allowedFirstAuthFactors: { password: true, emailOtp: false, smsOtp: false, passkey: false } }`. An explicit value is a real transition CloudFormation sends and Cognito applies, unlike an omission — read-only `aws cdk diff NdnAuthStack` against the already-drifted live pool showed exactly `[+] Added: .SignInPolicy` (a genuine addition from CloudFormation's own point of view, since its template had none), confirming this is a real change about to be sent, not another no-op.

**The lesson, stated for the next person who removes a Cognito pool property expecting it to reset:** verify the *live* resource after deploy, not only the synthesized template. `auth-stack.test.ts` asserts against the template CDK produces, which was correct throughout — the drift was never in what this codebase asked CloudFormation to do.

## Least privilege

| Role | Data-plane grant |
|---|---|
| `PatientAdminFunction` | `dynamodb:GetItem`/`PutItem` conditioned on `LeadingKeys PAT#*`; `dynamodb:PutItem` conditioned on `LeadingKeys AUDIT#*`; `cognito-idp:AdminCreateUser`/`AdminSetUserPassword` scoped to the patient pool's ARN only. No `AdminDeleteUser` anywhere — banned repo-wide by `packages/eslint-plugin-no-destructive` regardless. |

No SES, no SNS, no notification grant of any kind — the whole point of this design is that nothing here sends anything to a patient automatically. Compare `clinician-admin.ts`'s own role, which does carry an SES grant for the clinician deactivation notice; that channel exists because a clinician has a real, verified email, which a patient in this model does not need and is not asked for.

## Flag and rollback

`patients.administration.enabled`, **default off**, replacing the retired `auth.patientRegistration.enabled`. Off means both routes return `404`.

```bash
# open patient administration (after 2.5.1's approval route exists)
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/patients.administration.enabled --type String --value true
# close it again — no deploy, existing records untouched
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/patients.administration.enabled --type String --value false
```

Turned on together with `assignment.enabled`, the same "creating an account into a system with no route out of `pending` strands people there" reasoning `auth.patientRegistration.enabled` always carried.

## Verification

- `pnpm -r lint && pnpm -r typecheck && pnpm -r test` — all green across every workspace. `services/api`: 1391 tests (new: `password-generator.test.ts`, `patient-admin.test.ts`, plus the widened `authz.test.ts`/`dynamo-audit-log.test.ts` exhaustive suites picking up the new action automatically). `infra`: 244 tests (new: `DataStack — patient administration (D-29)`; updated: the audit-log role-count assertions, `AuthStack`'s pool-policy assertions).
- `aws cdk synth NdnAuthStack NdnDataStack` (admin profile, read-only) — succeeds.
- `aws cdk diff NdnAuthStack` (read-only, before merge) — confirmed **no replacement** of `PatientUserPool` or `PatientUserPoolClient`: `AccountRecoverySetting` (`verified_email` → `admin_only`), `AdminCreateUserConfig`, `Policies.PasswordPolicy`/`SignInPolicy`, `LambdaConfig` (removed) and the client's `ExplicitAuthFlows` all change in place. One `AWS::Lambda::Permission` (Cognito's own grant to invoke the now-deleted `PostConfirmationFunction`) is destroyed.
- `aws cdk diff NdnDataStack` (read-only, before merge) — purely additive/replacement-free: `RegistrationFunction`/`PostConfirmationFunction` and their roles, routes, log groups and permissions destroyed; `PatientAdminFunction` and its role/routes/log group/permission created. A handful of unrelated functions show a `Code.S3Key` change only — the expected esbuild re-bundle of every handler that transitively imports `authz-matrix.ts` or `audit.ts`, both edited by this change; no IAM or configuration change to any of them.
- **Post-deploy, 2026-08-29:** `describe-user-pool`/`describe-user-pool-client` against the real, deployed `ndn-patients` pool confirmed `AllowAdminCreateUserOnly: true`, `AccountRecoverySetting: admin_only`, the real `PasswordPolicy`, and the client's `ExplicitAuthFlows: [ALLOW_REFRESH_TOKEN_AUTH, ALLOW_USER_SRP_AUTH]` — all as intended. It also surfaced "A live finding" above (`SignInPolicy` left stale) — fixed the same day; `describe-user-pool` after that fix's own deploy confirmed `AllowedFirstAuthFactors: [PASSWORD]` for real.

## Status update, 2026-08-29 — live end-to-end verification, a real synthetic test patient

Both flags (`patients.administration.enabled`, `assignment.enabled`) flipped on via SSM the same day, and every route exercised against production for real — not simulated, not unit-tested. Since no staff-facing UI exists yet ("Not built yet" below), verification called the real, deployed `PatientAdminFunction`/`AssignmentFunction` directly (`aws lambda invoke`) with a synthesized API-Gateway-authorizer context standing in for a real bearer token — the identical `Principal` shape `request-principal.ts` validates regardless of how it arrived, so this exercises the same code path a real HTTP request would.

1. **`POST /patients`** created a real Cognito user and a real `PAT#`/`PROFILE` row (`account_status: pending`) for a synthetic patient (`synthetic.test.patient1+ndn@example.com`). Cognito's own `UserStatus` came back `CONFIRMED`, not `FORCE_CHANGE_PASSWORD` — the permanent-password design holding for real, not just in the code's own intent.
2. **A real SRP sign-in succeeded** against the deployed pool with the password the API returned — verified with an isolated scratch script (`amazon-cognito-identity-js`, no dependency added to this repo), never a simulation: real tokens came back, correct issuer, correct `sub`.
3. **`POST /patients/{id}/approve`** moved the record to `approved`, correctly assigned to a clinician, with the correct GSI1 projection (`gsi1pk: CLI#<clinicianId>`) — the unchanged approval step, proven working end to end for a staff-created account for the first time.
4. **`POST /patients/{id}/reset-password`** set a new password. The *old* password was confirmed rejected (`NotAuthorizedException`) and the *new* one confirmed working via a second real SRP sign-in.
5. **All three actions landed correct, distinctly-named audit rows** (`create`, the assignment's own `update`, `reset-password`), each attributed to the acting principal — queried directly from the live `AUDIT#2026-08-29` partition, not inferred.

**Left in place afterward, deliberately:** this synthetic patient as the first real, working fixture, and both flags **on** — the owner's own stated intent is continued testing with synthetic patients, not a one-off drill. Turn a flag back off with the same SSM command and `--value false` when a testing pause is wanted; nothing about leaving them on risks real patient data, since none exists in this account yet.

## Built after the live verification above: a minimal staff-facing UI, 2026-08-29

`/en/account/patient-admin` — two forms, both rendered only inside `RequireAuth`, both treating a `403` as an ordinary outcome the same way `CaseloadView.tsx`/`MessageThread.tsx` already do (the server-side `can()` check is the real boundary, not the page). `PatientAdminPanel.tsx` (new), wired in `patient-admin.astro`, registered in `account-routes.ts` (so the scheduled live-session a11y/keyboard suites pick it up automatically, the same guarantee every account-shell page since TASK 5.3.1 gets).

- **Create form** collects the same fields `POST /patients` accepts, trims them, and omits a blank optional field entirely rather than sending an empty string (`buildCreatePatientRequestBody`, the one piece of pure logic worth extracting and unit-testing — this directory's own established convention, per `ClinicianCalendar.test.ts`'s header, is to test the pure logic a component depends on rather than render the component itself, and this codebase has no jsdom/RTL harness for account-shell components to render into anyway).
- **Both the create and reset forms show the returned password exactly once**, in a plain `readonly` text input (select-all-and-copy, no Clipboard API permission to fail on) with an explicit "shown once, not saved anywhere" warning — the same one-time-disclosure discipline `patient-admin.ts`'s own header states for the API response itself, now stated to the human reading the screen too.
- **The one real limitation, named rather than hidden:** resetting a password needs the patient's account id, and this codebase has no lookup-by-email or lookup-by-name endpoint — `PAT#` records are keyed by id, not indexed by email, and the caseload view shows names, not ids. The create form's own success panel is the *only* place an id is ever surfaced before a patient is approved. Staff must keep the id from account creation (the UI's own copy says so); a real lookup is a deliberate, honestly-named follow-up this task does not attempt, not an oversight.
- **Verification:** `pnpm -r lint && pnpm -r typecheck && pnpm -r test` green (`apps/web`: 122 tests, 4 new); `pnpm --filter @ndn/web run build` — 23 pages, including `/en/account/patient-admin`, and its static output carries no more than the same accepted "the `client:only` component's own string props are serialised into the page" pattern `caseload.astro`'s own build output already has — no patient data, ever, in either.

## Not built yet — named honestly, not silently deferred

- **No automated identity verification.** The owner's own words: staff will be trained on how to verify who is real and who is not. That is a human process this codebase does not encode, check, or log beyond the audit row naming which principal acted — the same posture this system takes toward every human judgement call it does not attempt to automate.
- **No DPIA update yet.** The owner has deferred all legal/compliance review (DPIA, solicitor sign-off on R-04) until the technical system is proven working end-to-end with synthetic test patients — an explicit, informed decision, not an oversight. `docs/compliance/dpia-skeleton.md` records this new data flow as a placeholder for that eventual review; TASK 5.5.3's own go-live gate (LL-05/LL-06) is unaffected by anything in this task and still stands for real patient data.
- **No WhatsApp Business technical presence of any kind** — see "What WhatsApp Business is here, and what it is not" above. Publishing the number on the website is a content change, not an engineering one, and is not part of this task.

## A new risk this design introduces, named rather than hidden

Moving identity verification from "prove you can read this mailbox" (Cognito's own OTP mechanism) to "a human decides who they're talking to on WhatsApp" trades a weak, automatable check for a stronger but entirely human, unaudited-by-code one. Its failure mode is social engineering — someone convincing staff they are a patient they are not, or a patient who is not who they claim. This codebase cannot mitigate that with code; the owner's own mitigation is staff training, which is explicitly out of this codebase's scope to build or verify. Recorded in `docs/plan/02-risk-register.md` as a new risk rather than left implicit.

## Do NOT

- Build a WhatsApp Business API integration, template, or webhook as part of "finishing" this task — the design is a human channel, deliberately, and automating it undoes the entire point.
- Send a patient's generated password anywhere from this codebase — no email, no SMS, no log line. The one legitimate copy is the API response a human reads once.
- Grant `reset-password` or `create` on `Patient profile` to the assigned sub-clinician without a documented reason — the current scoping is Principal-only by design, not by oversight.
- Flip `patients.administration.enabled` on for real patient data before LL-05/LL-06 close, per TASK 5.5.3's own standing gate — this task's own flag is separate from, and does not substitute for, that gate. (Synthetic test-patient use, per the owner's own explicit instruction, is a different, already-approved case — see "No DPIA update yet" above.)
- Treat `AdminCreateUser`'s `email_verified: true` as meaning the address was actually verified. It was typed in by staff from a WhatsApp conversation, the same provenance `clinician-admin.ts` already accepts for a clinician's own invite address.
