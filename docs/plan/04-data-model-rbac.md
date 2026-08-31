# 5. Data model + RBAC

**Single DynamoDB table**, PK/SK overloaded, GSIs for the access patterns §7 requires.

| Entity | Key shape | Notes |
|---|---|---|
| Patient | `PAT#<id>` / `PROFILE` | `account_status`, `record_status`, `assigned_clinician_id`, `keywords[]` |
| Clinician | `CLI#<id>` / `PROFILE` | `role: principal\|sub`, `active` |
| Assignment request | `PAT#<id>` / `ASSIGNREQ#<ts>` | `pending\|approved\|declined` |
| Diagnosis / Care plan | `PAT#<id>` / `DIAG#<v>`, `PLAN#<v>` | **Versioned, append-only** |
| Assessment form | `PAT#<id>` / `ASSESS#<id>#v<n>` | `visible{}` and `private{}` as separate attributes |
| Appointment | `PAT#<id>` / `APPT#<iso-utc>` | GSI1 = clinician calendar |
| Content item | `CONTENT#<id>` / `META` | Blog/audio/video/text/image, per-language |
| Assignment of content | `PAT#<id>` / `CONTENT#<id>` | |
| Message | `PAT#<id>` / `MSG#<ts>` | Patient↔clinician, rate-limited |
| WS connection | `CONN#<connectionId>` / `PROFILE` | Operational metadata only — no `private{}`, no RBAC row (not reached via `can()`), native TTL is the only cleanup |
| Call participant | `CALL#<appointmentId>` / `CONN#<connectionId>` | TASK 4.2.1 — at most two live items per call, written only on an authorised, in-window join; same native TTL as the connection row it points at |
| Audit event | `AUDIT#<date>` / `<ts>#<id>` | **Append-only**, who/what/when/where |

GSIs: **GSI1** clinician→patients & calendar · **GSI2** keyword→content (FR-PP-10) · **GSI3** admin cross-caseload views (FR-DP-02). **GSI4** (appointment-window lookups for reminders) existed from TASK 3.4.3 until D-32 (2026-08-30) deleted the reminder sweep it served — see `docs/adr/0002-database.md`.

**RBAC matrix** (C=create R=read U=update J=join-call P=reset-password D=**never**, — = denied):

| Entity | Patient (own) | Patient (other) | Sub-clinician (assigned) | Sub-clinician (unassigned) | Helpdesk | Principal |
|---|---|---|---|---|---|---|
| Own profile | R U | — | R U | — | R U | R U |
| Patient profile | R U (self) | — | R U | — | C R U P | C R U P |
| Patient assignment | — | — | — | — | — | C R U |
| Diagnosis / care plan | **R** | — | C R U | — | **—** | C R U |
| Assessment — `visible{}` | R | — | C R U | — | **—** | R |
| **Assessment — `private{}`** | **—** | **—** | C R U | **—** | **—** | R |
| Appointments | R J | — | C R U J | — | — | R |
| Content assignment | R | — | C R U | — | C R U | R |
| Messages | C R (own thread) | — | C R (own patients) | — | **—** | R |
| Clinician accounts | — | — | — | — | **—** | C R U (deactivate only) |
| Audit log | — | — | — | — | — | R |
| Content item | — | — | C R U | C R U | C R U | C R U |
| Testimonial moderation | — | — | C R U | C R U | — | C R U |
| Workshop | — | — | C R U | C R U | — | C R U |

**2026-08-31 adds the `Helpdesk` column.** The owner: *"Besides principal clinician and clinician I also want to create an account for helpdesk person who will be able to either create a new patient account/registration or edit/upload content to existing patients including providing them new temporary password. This account will be able to login using the clinician sign in button."*

A helpdesk account lives in the **clinician pool** — that is what "login using the clinician sign in button" means, and it is also what makes the role possible at all: the pool already carries a `cognito:groups` claim the authorizer reads, so a third group (`helpdesk`) is a third role with no second directory and no second sign-in flow. It is emphatically *not* a third kind of clinician: `Clinician.role` gains `'helpdesk'`, and the singleton-principal invariant is untouched (many helpdesk accounts may exist, exactly one principal).

The column is **defined by its denials**, and every one of them is deliberate rather than an omission:

* **What it can do**, and only because the request names each: create a patient account (`Patient profile: C`), issue a new temporary password (`P` — the same action D-29 named precisely so that "hand someone a credential" is never hidden inside an `update`), find and read patients in order to do either (`R`), and upload and assign content (`Content item` and `Content assignment`: `C R U`). `U` on `Patient profile` is the one grant not literally in the request: it is the clerical data helpdesk types in at creation — a mistyped phone number or a corrected spelling — and withholding it would mean the person who made the typo is the one person who cannot fix it. If the owner would rather they could not, this is the single cell to strike.
* **No clinical reach whatsoever.** `Diagnosis / care plan`, both `Assessment` rows and `Messages` are denied outright. This is the whole reason for a distinct role rather than another sub-clinician: an administrator who can reset a patient's password must not thereby be able to read what a clinician wrote about them. Note this makes `Helpdesk` the only column in the table denied `Assessment — visible{}` while still holding `R` on the patient's own profile — the split is intentional and is the boundary the role exists to draw.
* **No assignment, and no clinician administration.** `Patient assignment` stays `Principal`-only, so a helpdesk-created account lands in `pending` and waits for the principal to assign a clinician — the same two-step D-29 already established, with the first step now delegable and the second not. `Clinician accounts` is denied for the obvious reason: a role that could create roles could create itself a principal.
* **No `Audit log`.** Reading who did what to whom is oversight, which is the principal's.
* **`Testimonial moderation` and `Workshop` denied**, unlike the sub-clinician columns. Nothing in the request asks for them, and marketing surfaces are not helpdesk work; `Content item` is granted only because "edit/upload content to existing patients" cannot be done without it.

**The clinician-private boundary is enforced at the repository layer** — a projection function strips `private{}` before data can reach any patient-facing serialiser. Not in the handler, not in the view: one chokepoint, 100% test coverage, negative test per endpoint forever (NFR-06).

**TASK 4.2.1 adds `J` to the Appointments row, narrower than `R`.** Joining an appointment's call is a stricter claim than reading its record — granted only to the owning patient and the assigned sub-clinician, the two parties actually on the call. The principal clinician keeps `R` (oversight — every appointment is readable) but does not gain `J`: "only an appointment's own two parties can join its call" is the task's own DoD, and a principal clinician who can read a calendar entry is not one of those two parties. `docs/plan/05-execution-plan.md`'s own text names only the owning patient and assigned clinician for this reason.

**D-29 (2026-08-29) adds `C` and `P` to this row's `Principal` column.** Patient accounts are no longer self-registered — TASK 2.2.3's own sign-up flow (Turnstile, Cognito `SignUp` with no password, email-OTP sign-in) is retired; see `docs/runbooks/patient-account-provisioning.md`. A patient now contacts the clinic's WhatsApp Business number; a human verifies who they are (staff are trained on this — it is a human process, not something this platform automates) and creates the account on their behalf, generating a password the patient does not choose and cannot change themselves. If they forget it, the same human resets it, again over WhatsApp — no self-service password recovery exists, or should ever be reachable, for a patient account. Both actions are scoped to `Principal` only, the same scoping the `Clinician accounts` row already uses for clinician provisioning, not extended to the assigned sub-clinician: creating or recovering a patient's own login credential is an identity-verification act, not a care-coordination one. **The existing approval step is unchanged.** A staff-created account still lands in `account_status: pending` through the same `PatientRepository.register()` this row's `C` now reaches; only `Patient assignment`'s own `create` — a distinct action on a distinct row, already reserved to the Principal — moves it to `approved`. Reusing that row's `create` for account creation instead of adding a new cell here would have let creating an account also approve it, which is not what either action means.

**TASK 2.5.4 adds the last three rows.** Content items, testimonial moderation and workshops are clinic-wide marketing/admin resources with no patient relationship to scope by — unlike every row above them, `Sub-clinician (assigned)` and `Sub-clinician (unassigned)` are identical cells here on purpose, because "assigned to a patient" has no meaning for a blog post. 2.5.4's own task text asks for "clinician-role authorisation" replacing the retired shared secret — read literally as *a* clinician, not *the* principal clinician specifically, which is also the least surprising reading given the old shared secret never distinguished between staff members either. `POST /workshops/media-upload-url` (media-upload.ts) reuses the Workshop row rather than getting its own — a presigned poster upload has no independent existence from the workshop it is for.
