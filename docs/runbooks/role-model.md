# The role model, end to end (2026-08-31)

**Date:** 2026-08-31 · **Supersedes parts of:** D-07, D-29, D-34, TASK 2.1.1, TASK 4.2.1 · **Authority:** [docs/plan/04-data-model-rbac.md](../plan/04-data-model-rbac.md)'s RBAC matrix

## Why this file exists

There are four roles now, and until today the answer to "who may do what" was scattered across a matrix, an authorizer, three panels and a page's worth of comments. The owner's own summary is the requirement:

> come up with a sensible role model so that principal can do anything, patient can edit his own details, helpdesk can help patient to do all what patient can do, including providing other details from the dashboard like upcoming appointments etc, and other clinician would be able to update his details… Only the principal clinician would be able to remove the patient/clinician including the option to reassign a patient to a different clinician.

The matrix is still the authority — this file is a reader's guide to it, plus the decisions that are not cells.

## The four roles

| | Signs in with | Cognito group | May exist |
|---|---|---|---|
| **Patient** | patient button | — (separate pool) | many |
| **Sub-clinician** | clinician button | none | many |
| **Helpdesk** | clinician button | `helpdesk` | many |
| **Principal** | clinician button | `principal-clinician` | **exactly one** |

A role is derived in exactly one place on each side, and the two mirror each other step for step: `authorizer.ts`'s `roleFor` (pool → group, from a *verified* token) and `apps/web/src/auth/token-claims.ts`'s `viewerRoleFromAccessToken` (pool → group, from the token the browser already holds, for rendering only). Any drift between them shows up as a page offered and then refused, or hidden from someone entitled to it — which is why the client's copy is written to match rather than to be clever.

## What each role can do

Read the matrix column by column, not row by row. In prose:

**Patient** — their own record, and nothing else. Read and update their own details (`/account/patient`), read their own diagnosis, care plan, visible assessments, appointments and assigned content, exchange messages with their clinician, join their own calls, and **change their own password**.

**Sub-clinician** — everything clinical, for their assigned patients only: diagnoses, care plans, assessments (both halves), appointments, content assignment, messages, calls. Plus their own details and password. Nothing about patients who are not theirs, and nothing administrative.

**Helpdesk** — the patient's administrative proxy. Register a patient account, issue a temporary password, read and correct any patient's details, read any patient's appointments, upload and assign content. **No clinical content of any kind** — diagnoses, care plans, assessments and messages are denied outright. No assignment, no clinician administration, no audit log.

**Principal** — everything a sub-clinician can do, on every patient, plus everything helpdesk can do, plus the four exclusive powers: assign and reassign a patient, suspend and restore a patient, create and deactivate clinician accounts, and read the audit log.

## The three decisions that are not cells

### 1. "The principal can do anything" was a correction, not a widening

The `Principal` column was read-only on assessments, appointments, content assignment and messages. That was never a policy — it was an assumption that the principal *oversees* and delegates the treating. Here the principal is the practice's own practising clinician, so the assumption was simply wrong, and those cells now match the treating sub-clinician's.

`join-call` moved with them and is the **one grant that genuinely widens a privacy boundary**. TASK 4.2.1's "only an appointment's own two parties can join its call" was right when the principal was never a party; now they routinely are, and `can()` resolves a principal by role alone, so it cannot tell "this appointment's own clinician" from "any appointment". With one practising clinician the alternative is a principal who cannot run a video call with their own patient. **Striking `J` from that one cell reverses it** if the practice grows.

### 2. Helpdesk gets appointments, and deliberately not diagnoses

"Help patient to do all what patient can do", taken literally, would extend to the patient's own read of diagnoses, care plans and visible assessments. It is not taken literally:

- the example given is administrative — "upcoming appointments etc";
- a helpdesk role that reads clinical records is a sub-clinician with extra steps, and the denial *is* the role;
- the asymmetry decides it. Granting a front-desk account clinical read cannot be undone once exercised; withholding it is three cells to change.

**If helpdesk should see clinical records, the cells are `Diagnosis / care plan`, `Assessment — visible{}` and `Messages` on the `Helpdesk` column.** Named here so the choice stays visible.

### 3. A patient may change their own password; reset is still staff-only

D-29's model is intact, because the thing it guards is not this route:

- **Reset** — "I have forgotten it, let me back in" — is an identity-verification act, and this platform has no channel it trusts to perform one automatically. Still staff-only, still over WhatsApp, still no recovery flow, no email link, no OTP.
- **Change** — this route — proves the *current* password to Cognito itself. Whoever can do it already holds the credential; it verifies no identity because it needs none. Refusing it protected nothing and left a patient unable to replace a password that staff had read aloud over WhatsApp.

Both Cognito web clients now request `aws.cognito.signin.user.admin`, without which `ChangePassword` fails with the same `NotAuthorizedException` a wrong password gives — the same trap D-34 hit on the clinician side.

## Suspension: why it is not `Patient profile: update`

"Remove a patient" is `POST /patients/{id}/suspend`, with `/restore` beside it, governed by **`Patient assignment`'s `update`** — Principal-only.

It could not ride `Patient profile`'s `update`, because helpdesk holds that one. "Correct a phone number" and "revoke this person's access" must not be the same permission, and putting them on the same cell would make them so. Suspension is not deletion and not unassignment: the record stays whole, `assigned_clinician_id` is untouched, and `restore` returns the patient to `approved` under the same clinician.

## Where each role lands in the UI

| Page | Patient | Sub-clinician | Helpdesk | Principal |
|---|---|---|---|---|
| `/account` | your details, password | your details, password | + staff links | + staff links, clinician accounts |
| `/account/patient` (own details) | ✓ | — | — | — |
| `/account/change-password` (own name + password) | password only | ✓ | ✓ | ✓ |
| `/account/caseload` (dashboard) | — | — | list, counts, open a record | + assign/reassign, + remove/restore access |
| `/account/patient-record?id=` | — | — | ✓ | ✓ |
| `/account/patient-admin` | — | — | ✓ | ✓ |
| `/account/clinician-admin` | — | — | — | ✓ |

Hiding is presentation only, and hides **on a positive answer alone**: a token whose claims cannot be read renders the content and lets the server refuse, because hiding a page from the one person entitled to it is far worse than briefly offering one the API will turn away. Every route behind every page re-derives the role from a verified token and checks the matrix, unchanged.

## The bug that made helpdesk look broken

`request-principal.ts` validates the authorizer's context with its own hardcoded `ROLES` list, and `'helpdesk'` was never added to it. Every helpdesk request therefore failed Zod validation and returned **401 before any handler ran** — the dashboard, the patient pages, everything. Nothing caught it: the array is a literal tuple, so widening `Role` was not a type error, and the matrix suite exercises `can()` directly rather than through that boundary.

It is now `satisfies readonly Role[]` plus a compile-time exhaustiveness check, so adding a role without editing that list is a build failure rather than a production 401.
