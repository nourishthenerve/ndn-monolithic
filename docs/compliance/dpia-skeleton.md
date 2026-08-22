# DPIA skeleton

This is a skeleton, not a completed Data Protection Impact Assessment. Full completion is **LL-05** (owner: you, with a DPO, lead time weeks, blocks launch, starts Phase 1) and is out of scope for the executor to fill in — see `docs/plan/08-long-lead.md`.

## Purpose

Tracks the data-protection design decisions the plan has already made so the DPO completing the full DPIA is working from an accurate starting point, not a blank page.

## Schema separation (TASK 0.3.4) — implemented 2026-08-09

Every person record is split into two independently addressable attribute sets:

- `clinical{}` — held on a clinical retention basis.
- `personal{}` — name, contact details, marketing preferences.

This split exists so that a future, human-authorised, field-level erasure of specific non-clinical fields needs no schema migration. See `docs/plan/04-data-model-rbac.md` and `docs/plan/05-execution-plan.md` (TASK 0.3.4).

The generic primitive lives in `services/api/src/person-record.ts`: `PersonRecord<Clinical, Personal>` plus `projectClinical`/`projectPersonal`/`withClinical`/`withPersonal`, proven independently addressable by `person-record.test.ts` (replacing one set never touches the other, by reference). No real entity is wired onto it yet and no erasure method exists — see `docs/runbooks/schema-separation-lawful-erasure.md`. The R-04 tension below is unchanged by this: the primitive makes a future erasure *cheap*, it does not authorise one.

## Audit log (TASK 2.1.3) — implemented 2026-08-22

Every write through the repository layer now lands a durable, append-only row (`AUDIT#<date>` / `<ts>#<id>`) recording **who, what, when and where**. Three properties matter to a DPIA:

- **Identifiers only.** A row records that a given entity was created/updated/transitioned by a given subject id, never the content of the change and never a name, email address or clinical value. This is enforced by construction — the writer builds its item field by field and cannot persist an attribute that is not one of the eight declared fields. See `docs/runbooks/audit-log.md`.
- **The "where" is a hash, not an address.** The plan specified a `sourceIp` field; it is stored as `sourceIpHash` (SHA-256), because an IP address is personal data and an audit row is the one row in this system that is never amended, never expired and never deleted (C-03). Storing it raw would put personal data permanently beyond the reach of any erasure decision the DPO later takes — which is the R-04 tension below, in its least resolvable form. A hash still answers the only question an audit trail asks of an address ("same origin as that one?").
- **Rows never expire.** No TTL attribute is written. Retention of audit rows is therefore indefinite and is a policy question the completed DPIA should answer explicitly, alongside the erasure policy below.

## Open tension — R-04

**GDPR erasure vs C-03 (never delete patient/clinical/content/media data) is unresolved by design.** This is a decision for your DPO/solicitor (**LL-06**), not a decision the executor makes unilaterally. See `docs/plan/02-risk-register.md` (R-04).

## What the DPO still needs to complete

- Lawful basis per processing activity.
- Necessity/proportionality assessment.
- The actual erasure policy that resolves R-04 within C-03's constraints.
- Sign-off recorded here once complete.

**Do NOT** treat this skeleton as a completed DPIA. **Do NOT** implement any erasure code path against this skeleton alone — that requires the sign-off above.
