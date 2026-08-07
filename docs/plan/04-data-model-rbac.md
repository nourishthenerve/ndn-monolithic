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
| Diagnosis / care plan | **R** | — | C R U | — | C R U |
| Assessment — `visible{}` | R | — | C R U | — | R |
| **Assessment — `private{}`** | **—** | **—** | C R U | **—** | R |
| Appointments | R | — | C R U | — | R |
| Content assignment | R | — | C R U | — | R |
| Messages | C R (own thread) | — | R (own patients) | — | R |
| Clinician accounts | — | — | — | — | C R U (deactivate only) |
| Audit log | — | — | — | — | R |

**The clinician-private boundary is enforced at the repository layer** — a projection function strips `private{}` before data can reach any patient-facing serialiser. Not in the handler, not in the view: one chokepoint, 100% test coverage, negative test per endpoint forever (NFR-06).
