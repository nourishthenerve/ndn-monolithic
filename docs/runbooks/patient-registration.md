# Patient self-registration and the approval lifecycle (TASK 2.2.3)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.2.3](../plan/05-execution-plan.md) · **Milestone:** M2.2 · **Requirements:** §5 · **Decisions:** D-03, D-09 · **Risks:** R-04 · **Depends on:** 2.2.2, 2.1.3, 0.3.4

## The invariant

> A patient can create an account. The account grants nothing until a clinician approves it. Every transition is audited with the clinician who made it. No path deletes a person.

## The flow, end to end

```text
browser ──POST /registrations──▶ RegistrationFunction
                                   ├─ flag: auth.patientRegistration.enabled (default OFF)
                                   ├─ Turnstile
                                   ├─ rate limit, 3/hour per hashed source IP
                                   ├─ Cognito SignUp (no password)
                                   └─ write REG#<sub> / INTAKE          ──▶ 202 Accepted

Cognito emails a code ──▶ browser confirms ──▶ PostConfirmation trigger
                                   ├─ read + consume REG#<sub> / INTAKE
                                   ├─ create PAT#<sub> / PROFILE, account_status: pending
                                   ├─ one audit row, actor = the patient
                                   └─ content-free confirmation email
```

## Why registration goes through us rather than straight to Cognito

The browser *could* call Cognito's `SignUp` directly — it is an unauthenticated API and TASK 2.2.1's client is public. Step 7 is what rules it out: it asks for a rate limit **per source IP**, and no Cognito Lambda trigger can see one. Pre-SignUp events carry `validationData`, `clientMetadata` and a caller context, and no client address; the address is only available on the paid threat-protection tier 2.2.1 declined. Behind API Gateway we have it for free.

So `POST /registrations` exists, and it is deliberately thin: Turnstile, rate limit, `SignUp`, park the intake row. It creates no patient record.

**`SignUp` is called with no password.** AWS's API reference: *"Users can sign up without a password when your user pool supports passwordless sign-in with email or SMS OTPs. To create a user with no password, omit this parameter."* Omitting it is what makes "no password" true of the account itself, not only of the sign-in path — the other half of the note in [cognito-user-pools.md](cognito-user-pools.md) about what the pool policy cannot express.

**The registration function holds no `cognito-idp` permission at all**, and there is a test asserting the string appears nowhere in the stack's IAM. `SignUp` "doesn't evaluate IAM policies" (AWS's own wording), so a grant would be permission that does nothing while reading, to anyone auditing later, as admin reach into the directory.

## The intake row, and why it has to exist

TASK 2.2.1 put **one** attribute on the patient pool: a required, mutable email. The app client can write only that. A name, a phone number and a marketing preference therefore have nowhere to live inside the directory — and putting them there would reopen the "no personal data in Cognito" decision the two-pool design rests on.

So they are parked at `REG#<sub>` / `INTAKE`, keyed by the `sub` `SignUp` just returned, and the trigger reads them back with one `GetItem`.

**The row is consumed, not deleted.** `take()` replaces the payload with `consumed: true` via an `UpdateExpression` with `REMOVE` on the named attributes. The row survives — so "this registration completed" stays a fact — and the patient's name stops existing anywhere except `PersonRecord.personal{}`, which is where R-04's future erasure can reach it and here is not. Data minimisation and 00-conventions.md's delete prohibition point the same way for once. `DeleteItem` appears nowhere.

An already-consumed row reads as absent, which is part of what makes a Cognito retry harmless.

## Idempotence, because Cognito retries

A Post-Confirmation trigger that throws is invoked again with the same event. Two things make that safe:

- `PatientRepository.register` returns the existing record when one exists, writing no second record and **no second audit row**. Three invocations leave one of each.
- The dangerous replay is the late one — Cognito retrying after a clinician has already approved. A second `create` would reset the account to `pending`; returning the existing record does not. There is a test named for exactly that.
- The second invocation finds no intake row (it was consumed). If registration were not idempotent it would rewrite the record with an empty name. Also its own test.

**A failure surfaces rather than being swallowed.** An exception fails the trigger and Cognito reports it to the caller. The alternative — catching so sign-up "succeeds" — leaves a confirmed Cognito account with no record, which TASK 2.2.2's authorizer denies on every request. A user who cannot sign in and does not know why is worse than one whose confirmation visibly failed.

The one exception is the confirmation email: a send failure is caught and logged. By then the account and the record are both real, and failing the trigger would undo neither while telling the patient their confirmation broke.

## `pending` grants nothing, and this task adds no code to make that true

TASK 2.1.1's `can()` already gates a non-operative status down to reading one's own profile, and `pending` is one. **This task adds no special case** — that was the point of building the matrix first. The authorizer (2.2.2) puts `account_status` on the `Principal` and `can()` reads it; nothing between them re-derives a permission.

## Two statuses, two facts

| Field | Values | Means |
|---|---|---|
| `account_status` | `pending` · `approved` · `declined` · `suspended` | whether this person may use the platform |
| `status` (`record_status`) | `active` · `deleted` | whether the row is live |

**`declined` is a status, never a deleted row**, and neither is `suspended`. A declined patient's record is still `GetItem`-able, their name still resolves on anything that references them, and the transition can be reversed — there is a test that declines and then approves. Collapsing the two fields would make "declined" and "deleted" the same fact, which is exactly what C-03 forbids.

`PatientRepository` exposes `register`, `transition`, `findById` and nothing else; a test asserts that method list, because "no path deletes a person" is a property of the class surface rather than of anybody's discipline.

## Transitions are a closed set, not a status patch

`approve` | `decline` | `suspend`. Not "set `account_status` to whatever you pass" — that is how a record reaches a state nobody designed. Each is audited with the acting principal:

| Transition | Status | Audit action |
|---|---|---|
| `approve` | `approved` | `update` |
| `decline` | `declined` | `reject` |
| `suspend` | `suspended` | `update` |

`decline` maps to `reject` because that is the word the log already uses for "a human refused this". Inventing a verb per transition would make a day of audit rows harder to read, not easier.

Registration itself is audited as `create` with the **patient** as actor — the first audit row in this system whose actor is a real person rather than `admin-token`, `public` or `system`. Cognito triggers carry no API Gateway request id and no client address, so the join key is the subject and the source is recorded as empty rather than as a fabricated address.

## The confirmation email says almost nothing

It goes to an address just verified but not yet approved, into a mailbox this clinic does not control — a shared family inbox, a work account, a phone on a lock screen. A subject line naming the clinic and the recipient is enough for a bystander to learn that someone is seeking neuro-rehabilitation.

So: **no name in the subject, no clinical language anywhere.** A test scans the whole message for `neuro`, `rehab`, `clinic`, `clinician`, `patient`, `condition`, `diagnosis`, `referral`, `appointment`, `treatment`, `therapy` and `symptom`, and fails on any of them. What remains is a receipt.

It sends **after** the record exists, never before — an email promising a registration was received must not be the only trace of one.

## Registering does not reveal who is already registered

`POST /registrations` answers identically whether the address was new or already had an account. Anything else turns this endpoint into an oracle for *"is this person a patient at a neuro-rehabilitation clinic"* — the disclosure TASK 2.2.1's `preventUserExistenceErrors` exists to prevent, undone by our own API. Cognito emails the address either way; only its owner learns which happened. There is a test that asserts the two responses are equal.

## Two log groups where the plan named one

Step 8 names `/ndn/registration-function`. The design needs two, because the two halves cannot be one Lambda: the rate limit needs an HTTP request to see a source IP, and the record creation needs a Cognito trigger to know when an address was verified. So `/ndn/post-confirmation-function` joins it, and both go to `UNMONITORED_LOG_GROUP_NAMES` — displacing nothing. Registration is a once-per-patient act behind a default-off flag and the trigger fires once per registration; at 509 patients over a year that is a few hundred invocations in total.

## Least privilege

| Role | Data-plane grant |
|---|---|
| `RegistrationFunction` | `dynamodb:PutItem` conditioned on `LeadingKeys REG#*`, `ssm:GetParameter` on the Turnstile secret. No Cognito permission. |
| `PostConfirmationFunction` | `GetItem`/`PutItem`/`UpdateItem` conditioned on `LeadingKeys` `PAT#*`, `REG#*`, `AUDIT#*`; `ses:SendEmail` scoped to the verified identity and configuration set. |

The trigger is the one function Cognito can invoke, so a table-wide grant would let a Cognito-side compromise reach every record in the estate. It writes audit rows and — per 2.1.3's separation — carries the audit-partition **read** denial, so it can append and never read back.

## Flag and rollback

`auth.patientRegistration.enabled`, **default off**. Off means the route returns `404`: not "you may not have it" but "this does not exist". It stays off until TASK 2.5.1 exists to approve anyone, because registering into a system with no route out of `pending` is not a smaller feature, it is a worse one.

```bash
# open registration (after 2.5.1)
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/auth.patientRegistration.enabled --type String --value true
# close it again — no deploy, existing records untouched
aws --profile ndn-prod ssm put-parameter --region eu-west-2 --overwrite \
  --name /ndn/flags/auth.patientRegistration.enabled --type String --value false
```

## Blocked on SES production access

The confirmation email and Cognito's own verification code both need to reach addresses this account has not verified. SES production access was **denied on 2026-08-21** ([ses-production-access.md](ses-production-access.md)) and Cognito's default sender is capped at **50 messages a day** ([cognito-user-pools.md](cognito-user-pools.md)).

**Neither is fixed by this task, and the flag must stay off until one of them is.** Turning registration on before then produces patients who never receive a code.

## Verification

- `pnpm -r lint && pnpm -r typecheck && pnpm test` — green. `services/api` 659 → **699**; `infra` 174 → **183**.
- `pnpm --filter @ndn/infra run synth` — all four stacks.
- **Not yet run:** the plan's end-to-end check (sign up, confirm, observe a `pending` record and one audit row) needs the flag on and mail that can leave the account. Deferred to the same moment the flag can be flipped, and named here rather than reported as done.

## Do not

- Grant any access on `pending`.
- Delete or overwrite a `declined` record.
- Put clinical content in the confirmation email.
- Auto-approve, for any reason, including for testing.
- Add a fourth transition without adding its audit action alongside it.
