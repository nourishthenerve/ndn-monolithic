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
| Audit event | `AUDIT#<date>` / `<ts>#<id>` | **Append-only**, who/what/when/where |

GSIs: **GSI1** clinician→patients & calendar · **GSI2** keyword→content (FR-PP-10) · **GSI3** admin cross-caseload views (FR-DP-02) · **GSI4** appointment-window lookups for reminders.

**RBAC matrix** (C=create R=read U=update D=**never**, — = denied):

| Entity | Patient (own) | Patient (other) | Sub-clinician (assigned) | Sub-clinician (unassigned) | Principal |
|---|---|---|---|---|---|
| Own profile | R U | — | R U | — | R U |
| Patient profile | R U (self) | — | R U | — | R U |
| Patient assignment | — | — | — | — | C R U |
| Diagnosis / care plan | **R** | — | C R U | — | C R U |
| Assessment — `visible{}` | R | — | C R U | — | R |
| **Assessment — `private{}`** | **—** | **—** | C R U | **—** | R |
| Appointments | R | — | C R U | — | R |
| Content assignment | R | — | C R U | — | R |
| Messages | C R (own thread) | — | R (own patients) | — | R |
| Clinician accounts | — | — | — | — | C R U (deactivate only) |
| Audit log | — | — | — | — | R |
| Content item | — | — | C R U | C R U | C R U |
| Testimonial moderation | — | — | C R U | C R U | C R U |
| Workshop | — | — | C R U | C R U | C R U |

**The clinician-private boundary is enforced at the repository layer** — a projection function strips `private{}` before data can reach any patient-facing serialiser. Not in the handler, not in the view: one chokepoint, 100% test coverage, negative test per endpoint forever (NFR-06).

**TASK 2.5.4 adds the last three rows.** Content items, testimonial moderation and workshops are clinic-wide marketing/admin resources with no patient relationship to scope by — unlike every row above them, `Sub-clinician (assigned)` and `Sub-clinician (unassigned)` are identical cells here on purpose, because "assigned to a patient" has no meaning for a blog post. 2.5.4's own task text asks for "clinician-role authorisation" replacing the retired shared secret — read literally as *a* clinician, not *the* principal clinician specifically, which is also the least surprising reading given the old shared secret never distinguished between staff members either. `POST /workshops/media-upload-url` (media-upload.ts) reuses the Workshop row rather than getting its own — a presigned poster upload has no independent existence from the workshop it is for.
