# 5. Data model + RBAC

**Single DynamoDB table**, PK/SK overloaded, GSIs for the access patterns §7 requires.

| Entity | Key shape | Notes |
|---|---|---|
| Patient | `PAT#<id>` / `PROFILE` | `account_status`, `record_status`, `assigned_clinician_id`, `keywords[]` |
| Clinician | `CLI#<id>` / `PROFILE` | `role: principal\|sub`, `active` |
| Assignment request | `PAT#<id>` / `ASSIGNREQ#<ts>` | `pending\|approved\|declined` |
| Diagnosis / Care plan | `PAT#<id>` / `DIAG#<v>`, `PLAN#<v>` | **Versioned, append-only** |
| Assessment form | `PAT#<id>` / `ASSESS#<id>#v<n>` | Four sections as four separate attributes — `general{}`, `patient{}`, `private{}`, `calendar{}` |
| Appointment | `PAT#<id>` / `APPT#<iso-utc>` | GSI1 = clinician calendar; `pending-approval` until the principal approves |
| Patient notification | `PAT#<id>` / `NOTIF#<ts>#<id>` | In-app dashboard feed — a kind and a time, never prose |
| Content item | `CONTENT#<id>` / `META` | Blog/audio/video/text/image, per-language |
| Assignment of content | `PAT#<id>` / `CONTENT#<id>` | |
| Message | `PAT#<id>` / `MSG#<ts>` | Patient↔clinician, rate-limited |
| WS connection | `CONN#<connectionId>` / `PROFILE` | Operational metadata only — no `private{}`, no RBAC row (not reached via `can()`), native TTL is the only cleanup |
| Call participant | `CALL#<appointmentId>` / `CONN#<connectionId>` | TASK 4.2.1 — at most two live items per call, written only on an authorised, in-window join; same native TTL as the connection row it points at |
| Audit event | `AUDIT#<date>` / `<ts>#<id>` | **Append-only**, who/what/when/where |

GSIs: **GSI1** clinician→patients & calendar · **GSI2** keyword→content (FR-PP-10) · **GSI3** admin cross-caseload views (FR-DP-02). **GSI4** (appointment-window lookups for reminders) existed from TASK 3.4.3 until D-32 (2026-08-30) deleted the reminder sweep it served — see `docs/adr/0002-database.md`.

**RBAC matrix** (C=create R=read U=update J=join-call P=reset-password D=**never**, — = denied):

| Entity | Patient (own) | Patient (other) | Sub-clinician (assigned) | Sub-clinician (unassigned) | Helpdesk | Visitor | Principal |
|---|---|---|---|---|---|---|---|
| Own profile | R U | — | R U | — | R U | R U | R U |
| Patient profile | R U (self) | — | R U | — | C R U P | **R (IIC-tagged only)** | C R U P |
| Patient assignment | — | — | — | — | — | — | C R U |
| Diagnosis / care plan | **R** | — | C R U | — | **—** | **—** | C R U |
| Assessment — `general{}` | **R U** | — | C R U | — | **C R U** | **R (IIC-tagged only)** | C R U |
| Assessment — `patient{}` | R | — | C R U | — | **C R U** | **—** | C R U |
| **Assessment — `private{}`** | **—** | **—** | C R U | **—** | **—** | **—** | C R U |
| Assessment — `calendar{}` | R | — | C R U | — | **R** | **R (IIC-tagged, two figures only)** | C R U |
| Appointments | R J | — | C R U J | — | **R** | **R (count only)** | C R U J |
| **Appointment approval** | — | — | — | — | — | — | **U** |
| Patient notifications | **R U (own)** | — | — | — | — | — | — |
| Content assignment | R | — | C R U | — | C R U | — | C R U |
| Messages | C R (own thread) | — | C R (own patients) | — | **—** | **—** | C R |
| Clinician accounts | — | — | — | — | **—** | — | C R U (deactivate only) |
| Audit log | — | — | — | — | — | — | R |
| Content item | — | — | **R** | **R** | **R** | — | C R U |
| Testimonial moderation | — | — | C R U | C R U | — | — | C R U |
| Workshop | — | — | **R** | **R** | — | — | C R U |

**2026-08-31 adds the `Helpdesk` column.** The owner: *"Besides principal clinician and clinician I also want to create an account for helpdesk person who will be able to either create a new patient account/registration or edit/upload content to existing patients including providing them new temporary password. This account will be able to login using the clinician sign in button."*

A helpdesk account lives in the **clinician pool** — that is what "login using the clinician sign in button" means, and it is also what makes the role possible at all: the pool already carries a `cognito:groups` claim the authorizer reads, so a third group (`helpdesk`) is a third role with no second directory and no second sign-in flow. It is emphatically *not* a third kind of clinician: `Clinician.role` gains `'helpdesk'`, and the singleton-principal invariant is untouched (many helpdesk accounts may exist, exactly one principal).

The column is **defined by its denials**, and every one of them is deliberate rather than an omission:

* **What it can do**, and only because the request names each: create a patient account (`Patient profile: C`), issue a new temporary password (`P` — the same action D-29 named precisely so that "hand someone a credential" is never hidden inside an `update`), find and read patients in order to do either (`R`), and upload and assign content (`Content item` and `Content assignment`: `C R U`). `U` on `Patient profile` is the one grant not literally in the request: it is the clerical data helpdesk types in at creation — a mistyped phone number or a corrected spelling — and withholding it would mean the person who made the typo is the one person who cannot fix it. If the owner would rather they could not, this is the single cell to strike.
* **No clinical reach whatsoever.** `Diagnosis / care plan`, both `Assessment` rows and `Messages` are denied outright. This is the whole reason for a distinct role rather than another sub-clinician: an administrator who can reset a patient's password must not thereby be able to read what a clinician wrote about them. Note this makes `Helpdesk` the only column in the table denied `Assessment — visible{}` while still holding `R` on the patient's own profile — the split is intentional and is the boundary the role exists to draw.
* **No assignment, and no clinician administration.** `Patient assignment` stays `Principal`-only, so a helpdesk-created account lands in `pending` and waits for the principal to assign a clinician — the same two-step D-29 already established, with the first step now delegable and the second not. `Clinician accounts` is denied for the obvious reason: a role that could create roles could create itself a principal.
* **No `Audit log`.** Reading who did what to whom is oversight, which is the principal's.
* **`Testimonial moderation` and `Workshop` denied**, unlike the sub-clinician columns. Nothing in the request asks for them, and marketing surfaces are not helpdesk work; `Content item` is granted only because "edit/upload content to existing patients" cannot be done without it.

**2026-08-31 (second amendment) — "the principal can do anything", and the role model settled end to end.** The owner, after using all three roles for real: *"come up with a sensible role model so that principal can do anything, patient can edit his own details, helpdesk can help patient to do all what patient can do, including providing other details from the dashboard like upcoming appointments etc, and other clinician would be able to update his details… Only the principal clinician would be able to remove the patient/clinician including the option to reassign a patient to a different clinician."*

The table above was written when the principal was modelled as an **overseer** — someone who reads across the practice and delegates the treating. That is not who the principal is here: they are the practice's own practising clinician. So the `Principal` column's read-only cells were not a policy, they were an assumption, and it was wrong. `Assessment` (both halves), `Appointments`, `Content assignment` and `Messages` all move from `R` to the same `C R U` the treating sub-clinician has.

`J` on `Appointments` moves with them, and it is the one grant here that genuinely widens a privacy boundary rather than correcting an assumption. TASK 4.2.1's narrowing — "only an appointment's own two parties can join its call" — was right when the principal was never a party. Now they routinely are, and `can()` resolves a principal to the `Principal` column by role alone, so it cannot tell "this appointment's own clinician" from "any appointment". The choice is therefore between a principal who cannot run a video call with their own patient and a principal who could join another clinician's. With one practising clinician today, the first is a daily obstruction and the second is hypothetical — but it *is* the trade, and **striking `J` from this one cell is how to reverse it** if the practice grows.

**The `Helpdesk` column gains `Appointments: R`, and deliberately nothing else.** The request reads "help patient to do all what patient can do", and taken literally that would extend to the patient's own `R` on diagnoses, care plans and `visible{}` assessments. It is not taken literally, because the example given is administrative ("upcoming appointments etc") and because a helpdesk role that reads clinical records is a sub-clinician with extra steps — the denial *is* the role. Granting clinical read to a front-desk account is also the kind of decision that cannot be undone once exercised, whereas withholding it is three cells to change. Named here so the choice is visible rather than implied: **if helpdesk should see diagnoses and assessments, the cells are `Diagnosis / care plan`, `Assessment — visible{}` and `Messages` on this column.**

The exclusive powers are unchanged and now complete: only `Principal` holds `Patient assignment` (approve, reassign, and — new the same day — suspend and restore a patient) and `Clinician accounts` (create, deactivate, reactivate). Suspending a patient rides `Patient assignment`'s own `update` rather than `Patient profile`'s, precisely because `Patient profile: U` is held by helpdesk: "correct a phone number" and "revoke this person's access" must not be the same permission.

"Other clinician would be able to update his details" is the `Own profile` row, which has been in this table since TASK 2.1.1 with no endpoint behind it. `PATCH /clinicians/me` is that endpoint.

**2026-08-31 (third amendment) — the `Visitor` column, and authoring narrowed to the principal.** The owner: *"I need a visitor account as well who can see basic name and address and number of appointments happened via clinician sign in way for all IIC tagged patients"*, and *"for blogs and webinar there is no way to upload it with tags/keywords - it will only be possible via principal clinician account."*

**`Visitor` is the narrowest column in the table, and the only one narrowed by *data* rather than by a cell.** Every other role's reach is settled entirely by the matrix; a visitor's is settled by the matrix *and* by `Patient.tag`. `can()` answers "may a visitor read a patient profile at all" — yes — and `caseload-repository.ts` answers "which ones" by skipping every patient not tagged `IIC`. Splitting it that way is deliberate: the matrix is a table of role-to-entity permissions and has no vocabulary for "rows where a field equals a value", and inventing one to express a single case would make every other cell harder to read. The cost is that the tag filter is enforced in one repository rather than in the policy layer, so it is named here and stated in that file's own header, not left to be discovered.

Two cells are narrower than "read a patient profile" implies, and both are enforced by projection rather than by the matrix, for the same reason:

* `Patient profile: R` reaches only `personal.fullName` and `personal.address` for this column. Not email, not phone, not `clinical{}`, not `account_status`, not who the patient is assigned to.
* `Appointments: R` reaches only a **count** of appointments whose status is `completed` — never a time, never a clinician, never a record. "Number of appointments happened" is the whole of what was asked for and the whole of what is returned.

A visitor writes nothing anywhere, and holds no cell on any other row. `Own profile: R U` is the one exception, and only so the same "your details / change your password" page every other signed-in role uses works for them too.

**Authoring narrowed to `Principal`.** `Content item` and `Workshop` were `C R U` for both sub-clinician columns, and `Content item` for `Helpdesk` as well. The owner's instruction is explicit — uploading a blog or a webinar "will only be possible via principal clinician account" — so `C` and `U` move to `Principal` alone. `R` stays everywhere it was: a clinician who cannot author a content item still has to be able to *list* content in order to assign it to a patient (`Content assignment`, unchanged), and a read that was already granted is not what the instruction narrows.

This is the first time a permission in this table has been *taken away* from a role that held it, rather than added. It is recorded as a narrowing on purpose: `authz.test.ts`'s independent copy of this table is what makes the change fail loudly in both directions, and the two authoring endpoints' own "is 403 for a sub-clinician" tests are new, not adjusted.

**The clinician-private boundary is enforced at the repository layer** — a projection function strips `private{}` before data can reach any patient-facing serialiser. Not in the handler, not in the view: one chokepoint, 100% test coverage, negative test per endpoint forever (NFR-06).

**TASK 4.2.1 adds `J` to the Appointments row, narrower than `R`.** Joining an appointment's call is a stricter claim than reading its record — granted only to the owning patient and the assigned sub-clinician, the two parties actually on the call. The principal clinician keeps `R` (oversight — every appointment is readable) but does not gain `J`: "only an appointment's own two parties can join its call" is the task's own DoD, and a principal clinician who can read a calendar entry is not one of those two parties. `docs/plan/05-execution-plan.md`'s own text names only the owning patient and assigned clinician for this reason.

**D-29 (2026-08-29) adds `C` and `P` to this row's `Principal` column.** Patient accounts are no longer self-registered — TASK 2.2.3's own sign-up flow (Turnstile, Cognito `SignUp` with no password, email-OTP sign-in) is retired; see `docs/runbooks/patient-account-provisioning.md`. A patient now contacts the clinic's WhatsApp Business number; a human verifies who they are (staff are trained on this — it is a human process, not something this platform automates) and creates the account on their behalf, generating a password the patient does not choose and cannot change themselves. If they forget it, the same human resets it, again over WhatsApp — no self-service password recovery exists, or should ever be reachable, for a patient account. Both actions are scoped to `Principal` only, the same scoping the `Clinician accounts` row already uses for clinician provisioning, not extended to the assigned sub-clinician: creating or recovering a patient's own login credential is an identity-verification act, not a care-coordination one. **The existing approval step is unchanged.** A staff-created account still lands in `account_status: pending` through the same `PatientRepository.register()` this row's `C` now reaches; only `Patient assignment`'s own `create` — a distinct action on a distinct row, already reserved to the Principal — moves it to `approved`. Reusing that row's `create` for account creation instead of adding a new cell here would have let creating an account also approve it, which is not what either action means.

**TASK 2.5.4 adds the last three rows.** Content items, testimonial moderation and workshops are clinic-wide marketing/admin resources with no patient relationship to scope by — unlike every row above them, `Sub-clinician (assigned)` and `Sub-clinician (unassigned)` are identical cells here on purpose, because "assigned to a patient" has no meaning for a blog post. 2.5.4's own task text asks for "clinician-role authorisation" replacing the retired shared secret — read literally as *a* clinician, not *the* principal clinician specifically, which is also the least surprising reading given the old shared secret never distinguished between staff members either. `POST /workshops/media-upload-url` (media-upload.ts) reuses the Workshop row rather than getting its own — a presigned poster upload has no independent existence from the workshop it is for.

## 2026-09-01 — the assessment form becomes four sections, and the calendar gets an approval step

The owner, specifying the form in full: *"this assessment form will have three sections. 1. General info 2. Specific to the patient 3. Specific to the clinician. The patient will be able to edit his general info only. The helpdesk can only edit specific to the patient section as well as general section. The clinician/principal clinican can edit all the sections."* Then, separately: *"Therefore I think we need one more section along with 1. General info, 2. Specific to the patient, 3. Specific to the clinician for calender."*

**Two rows became four, and the reason is that `visible{}` was never a section — it was "everything that isn't private".** The old split had exactly one boundary in it, and the owner has now drawn three. No arrangement of two rows expresses "helpdesk writes two of the sections but not the third", because helpdesk's reach is not a prefix of anyone else's: it is wider than the patient's on `patient{}` and narrower than the clinician's on `private{}`. So each section is its own row, `FieldSet` gains a member per section, and the record gains a property per section named identically — which is what lets a section-scoped write index the stored record by the same string `can()` was asked about, rather than a handler mapping one vocabulary onto another.

**`private{}` keeps its name.** It *is* "specific to the clinician" — the label is in `assessment-template.ts` — but the attribute stays `private` because `projection.ts`'s `stripPrivate`, `containsPrivateField` and `redactPrivateText` all key off that literal name, and those three are R-09's runtime boundary: the thing that keeps a clinical note out of a log line and out of an error message. Renaming the attribute to match the owner's phrasing would have silently unhooked all of it, and nothing would have failed until something leaked.

Cell by cell, and each one is the owner's sentence rather than an inference:

* **`general{}` — `Patient (own)`: `R U`.** The first write permission a patient has ever held on a clinical entity in this table, and it is exactly the one asked for: "the patient will be able to edit his general info only". Helpdesk gets `C R U` ("the helpdesk can only edit … as well as general section"), both clinician columns get `C R U` ("the clinician/principal clinican can edit all the sections").
* **`general{}` — `Visitor`: `R`, IIC-tagged only.** *"it will only be able to see the general info contant of only those patients that have been tagged IIC."* This is the second place a visitor's reach is narrowed by *data* rather than by a cell, and it is narrowed the same way the first one is: `can()` answers "may a visitor read a general section at all", and the handler skips every patient whose `tag` is not `IIC`. The tag check is in `assessment.ts` as well as `caseload-repository.ts` because they are two different reads — a visitor who could only be stopped at the list would still reach a record by guessing an id.
* **`patient{}` — `Patient (own)`: `R`, not `R U`.** "Specific to the patient" is written *about* the patient by staff, and the owner's edit permission for a patient is general info "only". They read it, because a section named for them that they cannot see would be a strange thing to hold, and nothing in the request withholds it.
* **`private{}` — unchanged, in every cell.** Both clinician columns write it, everybody else is denied outright, including read. R-09's own register entry ("a patient reaches no private assessment field, in any relationship") is asserted against this row exactly as it was.
* **`calendar{}` — `R` for patient, helpdesk and visitor; `C R U` for both clinician columns.** *"It will be edited by the clinician/principal clinician and helpdesk/visitor/patient will only be able to read it."* Read literally, and the visitor's read is IIC-gated by the same handler check as `general{}`'s — **and narrowed further to two figures**, see below.

**The calendar section stores almost nothing, and that is deliberate.** "When is the next appointment", "how many sessions so far" and "how many are awaiting approval" are all facts about `APPT#` rows, and they are computed from those rows on every read rather than stored alongside them. A stored copy would be a second answer the first time a write half-succeeded, and the `APPT#` rows are already the ones the approval workflow, the clinician calendar and the join-call window read. The only writable field in the section is a free-text scheduling note — which is what `C R U` on this row actually governs. Booking, moving and cancelling stay on the `Appointments` row, where they have always been.

**One field is narrower than its section, and it is the tag.** `tag` lives in `general{}`, and `general{}` is the one section a patient may write. A patient who could set their own tag could tag themselves `IIC` and thereby hand a visitor account a read of their own record — the tag is the entire mechanism by which a visitor's reach is bounded, so letting the subject of the record choose it inverts the control. The field is therefore marked `staffOnly` in the template and refused for a patient caller in `assessment.ts`, while every other role that may write the section may write it. This is the only field-level rule in the system, and it is on the field rather than in a handler branch so that the form and the API read it from the same declaration.

**`Appointment approval` is a new row, `Principal`-only, and `U` alone.** *"Any new appointment booked by the clinician needs to be approved by the principal clinician."* A sub-clinician's booking now lands in `appointment_status: 'pending-approval'` and only the principal moves it to `scheduled`. It is a distinct row rather than a widening of `Appointments`, for the same reason `Patient assignment` is distinct from `Patient profile`: "book a slot" and "decide whether that booking stands" are two powers, and the whole point of the request is that one role holds the first and a different role holds the second. The row carries no `C` and no `R` — there is nothing to create (the appointment already exists) and nothing to read that the `Appointments` row's own `R` does not already return, status included.

**A principal's own booking is `scheduled` immediately.** The approver approving themselves is a step with no decision in it, and a principal who had to approve their own bookings would either do it reflexively or forget, which makes the state mean less rather than more. The request names the clinician as the one whose bookings need approval, and the principal as the approver.

**`completed` and `no-show` finally have routes, on the `Appointments` row's existing `update`.** TASK 3.4.2 named both as the reason `appointment_status` has four values and built neither, so the field had never once held `'completed'` anywhere in this system. That was harmless until two features started counting it — the visitor's "number of appointments happened" and the calendar section's "sessions so far" — at which point both would have read zero forever, which is worse than a missing figure because it looks like a real one. Marking attendance is the treating clinician's act and rides the cell they already hold; it is deliberately *not* on `Appointment approval`, which is about whether a booking stands, not about whether it happened.

**A declined request becomes `cancelled`, not a fifth status.** Everything that reads `appointment_status` treats "declined before it was confirmed" and "cancelled after it was" identically — not happening, still in the history, skipped by the clinician calendar — and who decided it and when is already in the audit log. A `'declined'` value would be a state every consumer has to learn in order to handle it the same way.

**`Patient notifications` is a row with one column filled in.** The owner: *"When a clinician/principal clinician edits a calender for a given patient it will appear as a notification on patients logged in dashboard."* The feed is a row per event on the patient's own partition, and the only HTTP reach anyone has to it is the patient's own `R U` — read the feed, mark an item read. **The clinician columns are `—` and that is not an omission:** a notification is never created by an HTTP call, it is a side effect of an appointment action that has *already* been authorised on the `Appointments` or `Appointment approval` row. Giving a clinician `C` here would create a second, independently reachable way to put text on a patient's dashboard, which is exactly what this row should not be. The record carries a kind and a time and no prose, so there is no message for anyone to author in the first place.

## 2026-09-01 (second amendment) — the visitor's calendar is two figures

Asked whether a visitor should keep the old count-only view of appointments or gain the calendar section the first cut had given them, the owner: *"i want visitor read only both total number of appointments and next appointment."*

Read as an **enumeration**, not an example — which makes it a narrowing as well as an addition, and the narrowing matters more than the addition.

**What it closes.** The first cut implemented "a visitor may read the calendar section" as "a visitor may read everything in that section". The only *stored* field in the calendar is `schedulingNotes` — free text a clinician writes about a patient — so a partner organisation's read-only account was being sent clinician-authored prose. Nothing asked for that; it arrived as a side effect of a section-level permission being applied to a section that happens to contain one written field. The `Visitor` column has been the narrowest in this table since it was created precisely so this kind of thing has to be argued for, and it was not.

So a visitor's calendar is now **derived figures only, and only two of them**:

* `totalAppointments` — every appointment that stands.
* `nextAppointmentAt` (with its duration).

And explicitly not: the stored `schedulingNotes`, any attachment, `sessionsCompleted`, or `appointmentsAwaitingApproval`. That last omission is worth its own sentence: a total that moved as the principal worked through an approval queue would leak the practice's internal workflow to an outside account one increment at a time, so a visitor's figure only ever moves when something real does.

This is the **third** narrowing applied to the `Visitor` column outside the matrix, after the tag filter and the field-level projection in `caseload-repository.ts`, and the reason is unchanged each time: the matrix says which *rows* a role may reach, never which *fields* of a row. Each one is therefore named here in words and enforced at one chokepoint in code (`VISITOR_CALENDAR_FIELDS` in `assessment.ts`), not left to be discovered.

**"Total number of appointments" is defined once, in `@ndn/shared-types`.** `COUNTED_APPOINTMENT_STATUSES` is `scheduled`, `completed` and `no-show`: an appointment counts once it stands. `cancelled` never happened, and `pending-approval` is not confirmed. The definition is shared because a visitor sees this figure on **two** screens — the dashboard list and the assessment form — and one patient showing two different totals would be worse than either figure alone. The dashboard's own column moved with it (`countCompletedAppointments` → `countAppointments`, "Appointments attended" → "Appointments in total"), so the two now cannot drift.
