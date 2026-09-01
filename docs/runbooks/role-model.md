# The role model, end to end (2026-08-31)

**Date:** 2026-08-31 · **Supersedes parts of:** D-07, D-29, D-34, TASK 2.1.1, TASK 4.2.1 · **Authority:** [docs/plan/04-data-model-rbac.md](../plan/04-data-model-rbac.md)'s RBAC matrix

## Why this file exists

There are four roles now, and until today the answer to "who may do what" was scattered across a matrix, an authorizer, three panels and a page's worth of comments. The owner's own summary is the requirement:

> come up with a sensible role model so that principal can do anything, patient can edit his own details, helpdesk can help patient to do all what patient can do, including providing other details from the dashboard like upcoming appointments etc, and other clinician would be able to update his details… Only the principal clinician would be able to remove the patient/clinician including the option to reassign a patient to a different clinician.

The matrix is still the authority — this file is a reader's guide to it, plus the decisions that are not cells.

## The five roles

| | Signs in with | Cognito group | May exist |
|---|---|---|---|
| **Patient** | patient button | — (separate pool) | many |
| **Sub-clinician** | clinician button | none | many |
| **Helpdesk** | clinician button | `helpdesk` | many |
| **Visitor** | clinician button | `visitor` | many |
| **Principal** | clinician button | `principal-clinician` | **exactly one** |

A role is derived in exactly one place on each side, and the two mirror each other step for step: `authorizer.ts`'s `roleFor` (pool → group, from a *verified* token) and `apps/web/src/auth/token-claims.ts`'s `viewerRoleFromAccessToken` (pool → group, from the token the browser already holds, for rendering only). Any drift between them shows up as a page offered and then refused, or hidden from someone entitled to it — which is why the client's copy is written to match rather than to be clever.

## What each role can do

Read the matrix column by column, not row by row. In prose:

**Patient** — their own record, and nothing else. Read and update their own details (`/account/patient`), read their own diagnosis, care plan, visible assessments, appointments and assigned content, exchange messages with their clinician, join their own calls, and **change their own password**.

**Sub-clinician** — everything clinical, for their assigned patients only: diagnoses, care plans, assessments (both halves), appointments, content assignment, messages, calls. Plus their own details and password. Nothing about patients who are not theirs, and nothing administrative.

**Helpdesk** — the patient's administrative proxy. Register a patient account, issue a temporary password, read and correct any patient's details, read any patient's appointments, upload and assign content. **No clinical content of any kind** — diagnoses, care plans, assessments and messages are denied outright. No assignment, no clinician administration, no audit log.

**Visitor** — a partner organisation's read-only account, and the narrowest role in the system. It sees one screen: the patients tagged `IIC`, by **name and address**, with a count of the appointments that **actually happened** (`completed` — never scheduled, cancelled or no-show). No email, no phone, no status, no clinician, no clinical content, no links into anything, and no write of any kind. Plus its own name and password, like everyone else.

**Principal** — everything a sub-clinician can do, on every patient, plus everything helpdesk can do, plus **authoring blog posts and workshops**, plus the four exclusive powers: assign and reassign a patient, suspend and restore a patient, create and deactivate clinician accounts, and read the audit log.

## Patient tags, and the one rule the matrix does not hold

Every patient carries a `tag` — `NDN` (the clinic's own) or `IIC` (the partner programme) — set when the account is created and changeable afterwards only by staff, never by the patient themselves. It is top-level on the record rather than inside `personal{}` or `clinical{}`: it is neither something the patient gave us nor something held on a clinical basis, but an operational fact the practice assigns, exactly like `account_status`. It is also load-bearing for authorisation, which is a further reason not to bury it in a bag of fields a future erasure pass may empty.

**A visitor's reach is narrowed by that field, not by a matrix cell**, and this is the single place in the system where that is true. `can()` answers "may a visitor read a patient profile at all"; `caseload-repository.ts` answers "which ones" by skipping every record not tagged `IIC`. The matrix has no vocabulary for "rows where a field equals a value", and inventing one to serve a single case would make every other cell harder to read — so the split is deliberate, and named here rather than left to be discovered.

Two properties of that filter matter and are tested:

- a non-matching patient is **skipped, not redacted** — a blanked row would still disclose that the patient exists;
- an **untagged** record (written before tagging existed) is not `IIC`. Absence is never read as membership.

The tag a visitor may see is a constant, not a request parameter. There is nowhere in the request to ask for another programme's patients. If a second partner ever needs an account, the tag becomes a field on their own `CLI#` record — still never read from the request.

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

| Page | Patient | Sub-clinician | Helpdesk | Visitor | Principal |
|---|---|---|---|---|---|
| `/account` | your details, password | your details, password | + staff links | dashboard link only | everything |
| `/account/patient` (own details) | ✓ | — | — | — | — |
| `/account/change-password` (own name + password) | password only | ✓ | ✓ | ✓ | ✓ |
| `/account/caseload` (dashboard) | — | — | list, counts, open a record | **name, address, appointments attended** | + assign/reassign, remove/restore |
| `/account/patient-record?id=` | — | — | ✓ | — | ✓ |
| `/account/patient-admin` | — | — | ✓ | — | ✓ |
| `/account/clinician-admin` | — | — | — | — | ✓ |
| `/account/authoring` (blog, workshops) | — | — | — | — | ✓ |

The dashboard is one route rendering two different tables. A visitor gets name / address / appointments-attended, with the patient's name as **plain text rather than a link** — the record page is denied to them, so a link would be an invitation to a 403. Everyone else gets status / clinician, and the principal gets the two action columns on top.

Hiding is presentation only, and hides **on a positive answer alone**: a token whose claims cannot be read renders the content and lets the server refuse, because hiding a page from the one person entitled to it is far worse than briefly offering one the API will turn away. Every route behind every page re-derives the role from a verified token and checks the matrix, unchanged.

## Authoring: the first permission ever taken away

`Content item` and `Workshop` were `C R U` for both sub-clinician columns, and `Content item` for helpdesk too. The owner: uploading a blog or a webinar "will only be possible via principal clinician account", so `C` and `U` are now `Principal`'s alone.

`R` stays exactly where it was, and that is not an oversight: a clinician who cannot author a content item still has to be able to *list* content in order to assign it to a patient (`Content assignment`, unchanged).

This is the first time a cell in this table has been narrowed rather than widened. `authz.test.ts`'s independent copy of the doc is what makes that fail loudly in both directions, and the "is 403 for a sub-clinician" test on the content endpoint is a rewrite of the "accepts a sub-clinician" test that stood there before — the change is visible in the diff rather than buried in a new file.

The API itself needed nothing: `POST /content` and `POST /workshops` have carried keywords, translations and publish/unpublish since TASK 1.3.2 and 1.5.1. What never existed was a way to reach them — every blog post and workshop on the live site was written by calling the API by hand. `/account/authoring` is that surface, create-only for now (editing needs a list, a loaded draft and a diff — a screen in its own right, and a bad version of it beside a good create form would be worse than not building it yet).

## The bug that made helpdesk look broken

`request-principal.ts` validates the authorizer's context with its own hardcoded `ROLES` list, and `'helpdesk'` was never added to it. Every helpdesk request therefore failed Zod validation and returned **401 before any handler ran** — the dashboard, the patient pages, everything. Nothing caught it: the array is a literal tuple, so widening `Role` was not a type error, and the matrix suite exercises `can()` directly rather than through that boundary.

It is now `satisfies readonly Role[]` plus a compile-time exhaustiveness check, so adding a role without editing that list is a build failure rather than a production 401. It earned its keep within the hour: `'visitor'`, added later the same day, failed the build there before it could reach anything.

## One more, reported the same day: the assign dropdown offered helpdesk

`GET /clinicians` returns the whole directory, and the dropdown filtered it by `account_status === 'active'` alone. A helpdesk (and now a visitor) account is a `Clinician` record in that directory and *is* active, so both were offered as people to assign a patient to — and neither treats anyone.

Fixed on both sides, and the server side is the one that matters: `AssignmentRepository` now refuses a non-treating target with `CLINICIAN_NOT_AVAILABLE` (`TREATING_CLINICIAN_ROLES`, checked alongside the status it already checked), so an assignment to a helpdesk account is impossible rather than merely un-offered. The dropdown filter is the courtesy on top.

## Two more found the same evening, both silent

### The blog form rejected every ordinary title

Reported as "blog posting is not working". Nothing was in any log — not the authoring Lambda's, not the authorizer's — because **no request was ever sent**. The form required a hand-typed *web address* in slug form and validated it client-side, so "My first post" was refused before the fetch.

Asking a clinician to know what a slug is was the mistake. The title is the thing an author actually has, so the address is now derived from it (`slugify`, folding accents rather than dropping the letter) and shown in an editable field that stops following the title the moment it is edited by hand. The field is no longer `required` in HTML either: an empty one produces this codebase's own explanatory message rather than the browser's "Please fill out this field".

### `PATCH` was never allowed through CORS

Found while chasing the above, and much wider than it. The HTTP API's `corsPreflight.allowMethods` was `[GET, POST]` — and `PATCH` is not a CORS-simple method, so a browser preflights it and refuses to send the real request when the preflight response omits it. **Nothing reaches the API, so nothing appears in any log.**

Every `PATCH` this site makes from a browser was dead the whole time:

- a patient saving their own profile (`PATCH /patients/me`, live since TASK 3.1.1),
- a clinician correcting a patient's details (new the same day),
- a clinician renaming themselves (new the same day).

Only handler tests and `curl` ever exercised those routes, and neither preflights. This is the identical silent shape as the API's 2026-08-22 CORS defect, where `allowOrigins` still named only `next.` after the apex cutover — and it was found the same way, by asking why a request had left no trace anywhere.

`allowMethods` is now exactly the methods this API routes, and `data-stack.test.ts` asserts both halves: the list is `['GET', 'POST', 'PATCH']`, and no route uses a method the list omits. A route added with a method nobody adds there now fails a test instead of failing silently in a browser.

## Amendment, 2026-09-01 — the assessment form's four sections

The role model itself is unchanged: the same five roles, the same two sign-in buttons, the same pools. What changed is the *granularity* of one entity.

The assessment form used to be two matrix rows (`visible{}`/`private{}`). It is now four — `general{}`, `patient{}`, `private{}`, `calendar{}` — one per section of the owner's own form, because the four sections have four different sets of writers and no arrangement of two rows expresses that. Read the four rows down `docs/plan/04-data-model-rbac.md`'s table rather than across this file; what follows is only what each role's *reach* now amounts to.

| Role | What the assessment form gives them |
|---|---|
| Patient | Reads general, patient and calendar. **Writes general only** — the first write permission a patient has ever held on a clinical entity here — and not the `tag` field inside it. |
| Helpdesk | Reads and writes general and patient. Reads calendar. Denied the clinician section outright, which is the boundary the role exists to draw. |
| Visitor | Reads general and calendar, **for `IIC`-tagged patients only**. Writes nothing anywhere. |
| Clinician (assigned) | All four sections, read and write. |
| Principal clinician | All four sections, read and write, for every patient. |

Two things about this table are enforced outside the matrix and are easy to miss:

- The visitor's tag filter is applied in `assessment.ts` as well as `caseload-repository.ts`. They are two different reads, and a visitor stopped only at the list would still reach a record by guessing an id.
- The patient's inability to set their own `tag` is a *field*-level rule, marked `staffOnly` on the template. It matters because the tag is the whole mechanism bounding a visitor's reach: a patient who could tag themselves `IIC` would be handing a visitor account a read of their own record.

Two new powers land on the `Principal` column, both on their own rows and both `Principal`-only: **`Appointment approval`** (a sub-clinician's booking waits for it — see `docs/runbooks/appointments.md`) and nothing else. `Patient notifications` is the one row in the table whose only filled cell belongs to the patient.

## Amendment, 2026-09-01 (second) — what a visitor actually sees, in full

The `Visitor` row of the table above says "reads general and calendar, for `IIC`-tagged patients only". That is true at the level of *sections*; below the section level it is narrower still, and this is the complete list, because a visitor is an outside organisation's account and "what can they see" should be answerable without reading three files.

On the **dashboard list** (`caseload-repository.ts`), one row per `IIC`-tagged patient:

- full name
- address
- total number of appointments

On the **assessment form** (`assessment.ts`), for one `IIC`-tagged patient:

- the whole `general{}` section — its answers and its attachments
- from `calendar{}`: the total number of appointments, and the next appointment with its length. **Nothing else** — not the clinician's scheduling notes, not the count of sessions completed, not how many bookings await the principal's approval.

And nothing at all from `patient{}` or `private{}`, no messages, no diagnosis, no care plan, no account status, no assigned clinician, no email, no phone.

A visitor writes nothing anywhere, on any route, including their own `tag`. The only thing they may change is their own password, through the same page every other signed-in role uses.

Three of those narrowings are not expressible as matrix cells and are enforced in code at one place each — the `IIC` tag filter, the dashboard's field projection, and `VISITOR_CALENDAR_FIELDS`. If the owner ever wants a visitor to see more, those three constants and the one matrix row are the whole surface to change.
