# DPIA skeleton

This is a skeleton, not a completed Data Protection Impact Assessment. Full completion is **LL-05** (owner: you, with a DPO, lead time weeks, blocks launch, starts Phase 1) and is out of scope for the executor to fill in — see `docs/plan/08-long-lead.md`.

## Purpose

Tracks the data-protection design decisions the plan has already made so the DPO completing the full DPIA is working from an accurate starting point, not a blank page.

## Schema separation (TASK 0.3.4)

Every person record is split into two independently addressable attribute sets:

- `clinical{}` — held on a clinical retention basis.
- `personal{}` — name, contact details, marketing preferences.

This split exists so that a future, human-authorised, field-level erasure of specific non-clinical fields needs no schema migration. See `docs/plan/04-data-model-rbac.md` and `docs/plan/05-execution-plan.md` (TASK 0.3.4).

## Open tension — R-04

**GDPR erasure vs C-03 (never delete patient/clinical/content/media data) is unresolved by design.** This is a decision for your DPO/solicitor (**LL-06**), not a decision the executor makes unilaterally. See `docs/plan/02-risk-register.md` (R-04).

## What the DPO still needs to complete

- Lawful basis per processing activity.
- Necessity/proportionality assessment.
- The actual erasure policy that resolves R-04 within C-03's constraints.
- Sign-off recorded here once complete.

**Do NOT** treat this skeleton as a completed DPIA. **Do NOT** implement any erasure code path against this skeleton alone — that requires the sign-off above.
