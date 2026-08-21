# Nourish the Nerve — Neuro-Rehab Platform: Plan Index

Source: `ndn-planning-brief-md-this-is-cozy-sunrise.md` (repo root) — produced under the two-stage protocol in `ndn-planning-brief.md`. This index and the documents it points to are the committed, versioned form of that plan (TASK 0.0.1).

## Context

Nourish the Nerve is a UK neuro-rehabilitation clinic that today has only a static brochure site. It needs a real platform: patients register, are approved and assigned to a clinician, then access their diagnosis, care plan, appointment calendar, clinician-assigned educational content and 1:1 video consultations. Clinicians run assessments during those calls; a principal clinician oversees the whole caseload. A public site carries blogs, paid workshops, testimonials and a contact route.

Three constraints shape every decision in this plan: **£20/month all-in ex-VAT** (designed to £12–14), **zero downtime with no staging environment**, and an absolute prohibition on code that deletes patient, clinical, content or media data.

**Verified position (2026-08-07):** greenfield repo (zero commits at plan time), domain and DNS under our control in AWS account 803129122420, live brochure site served from what looked like a *different* unidentified AWS account (corrected 2026-08-21: it is an Amplify app inside 803129122420 — `docs/runbooks/g1-cutover.md`), and a legacy click-ops Lambda with a public unauthenticated URL holding delete rights over an unversioned bucket. Planning FX £1 = $1.2105 ($1.345 ECB less the 10% adverse buffer required by C-01).

## Document map

| Doc | Contents |
|---|---|
| [00-conventions.md](00-conventions.md) | Executor pack — stack, layout, sizing, error/logging/naming rules, the destructive-primitive prohibition |
| [01-decisions.md](01-decisions.md) | Decision log D-01…D-28 |
| [02-risk-register.md](02-risk-register.md) | Risk register R-01…R-14 |
| [03-cost-model.md](03-cost-model.md) | Costed bill of materials (M1/M6/M12) |
| [04-data-model-rbac.md](04-data-model-rbac.md) | Single-table DynamoDB data model, GSIs, RBAC matrix |
| [05-execution-plan.md](05-execution-plan.md) | Full task breakdown — Phases 0, 1 and 2 in detail, Phases 3–7 as milestone stubs |
| [06-gate-checklists.md](06-gate-checklists.md) | What is run and reported at every gate |
| [07-traceability.md](07-traceability.md) | FR/NFR coverage summary |
| [08-long-lead.md](08-long-lead.md) | Long-lead register (LL-01…LL-10) |
| [09-self-audit.md](09-self-audit.md) | Plan self-audit, red-team, and the one place the plan pushes back on the brief |
| [`docs/adr/0001..0017-*.md`](../adr/) | Architecture Decision Records, one per line of §3 plus ADR-0017 (frontend framework, added at Gate G0 ahead of Phase 1). ADR-0004 carries a Gate G1 amendment (two Cognito user pools) added ahead of Phase 2 on the same precedent |
| [`docs/compliance/dpia-skeleton.md`](../compliance/dpia-skeleton.md) | DPIA skeleton (schema separation for future lawful erasure, R-04) |

Appendix A (Stage A discovery findings, verified 2026-08-07) remains in the source planning-brief file at the repo root; it is not duplicated here.
