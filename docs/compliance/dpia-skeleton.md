# DPIA skeleton — generic placeholder, reframed for India (D-33)

## Reframe, D-33 (2026-08-30) — read this section first

**This document was originally written assuming a UK DPO would complete a UK-GDPR DPIA. That framework doesn't apply**: this business has no UK establishment, and every customer and clinician is India-based (the same facts that closed LL-04 — see `docs/plan/08-long-lead.md`). **India's own Digital Personal Data Protection Act, 2023 (DPDPA)** — and whatever telemedicine/professional-conduct rules apply to the clinicians using this platform — is the framework that actually governs this system, and **neither has been assessed by anyone qualified as of this reframe.**

**The owner's own words, asked directly whether this could wait:** *"I will get it done legally later on but I want to go live now for real patients. go with it."* Track B (the patient-facing platform — profiles, clinical records, appointments, messaging, video) went live for real patients on 2026-08-30 on that explicit instruction, **before** this document represents anything a qualified Indian data-protection/health-law professional has reviewed. That is a conscious, informed decision to accept real, unresolved legal exposure temporarily — not a claim that the exposure doesn't exist, and not something this codebase, or the assistant that reframed this document, is qualified to resolve on its own.

**This remains a generic placeholder, not a completed assessment, and not legal advice.** Everything below this section was written to track *technical* design decisions that happen to be jurisdiction-agnostic (they describe what the system does, not which law applies to it) — it is not a substitute for LL-05/LL-06 actually closing with real Indian counsel. Do not present this document, to a regulator, an auditor, a patient, or anyone else, as evidence that a completed DPIA or legal sign-off exists. It does not.

## Purpose

Tracks the data-protection *design* decisions the plan has already made — true regardless of which jurisdiction's law ends up applying — so whoever eventually completes the real assessment (LL-05/LL-06, `08-long-lead.md`) is working from an accurate starting point, not a blank page.

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

## Assessment forms: the two-row visible{}/private{} split (TASK 3.3.1/3.3.2) — implemented 2026-08-22

`Assessment { visible: { formType, responses }; private?: { clinicianImpression } }` — a named, versioned form (`PAT#<id>` / `ASSESS#<assessmentId>#v<n>`) a clinician re-administers over time. Two properties matter to a DPIA:

- **A `private{}` clinical field, not just a schema label.** `clinicianImpression` is a real instance of the `personal{}`/`clinical{}` split's own `private{}` half named above (TASK 0.3.4) — the first entity in this codebase to actually populate it. `services/api/src/projection.ts`'s repository-layer chokepoint (TASK 2.1.2) strips it from every response the owning patient's own token can reach; `authz-matrix.ts` carries it as its own matrix row (`'Assessment — private{}'`), read-only even to the principal clinician, never the assigned sub-clinician's patient. Proven by a negative test on every read path, per `docs/runbooks/private-field-boundary.md`'s own standing convention.
- **Authorship is narrower than reading.** Only the assigned sub-clinician may write either half (`'Assessment — visible{}'`'s own matrix row is bare `R` for the principal) — the assessment is administered by whoever is physically running the sitting, not signed off by a supervising principal after the fact. Relevant to "who processes this data" in a completed DPIA's own lawful-basis table.

## Messaging: patient↔clinician, content-free notifications (TASK 3.6.1) — implemented 2026-08-24

`Message { patientId, senderId, senderRole, body }`, append-only (`PAT#<id>` / `MSG#<ts>`) — never edited or removed once sent, the same discipline every entity in this table follows. Two properties matter to a DPIA:

- **The message body is clinical/personal content stored indefinitely** — no TTL, no expiry, matching the audit log's own "retention is a policy question the completed DPIA should answer explicitly" note above, now with a second entity in the same position.
- **The notification the other party receives on a new message is content-free by construction** — "you have a new message," never the body — the same privacy posture every notification template in this codebase states for a mailbox that may not be the recipient's alone to read (e.g. a shared device). See `docs/runbooks/messaging.md`.

## Video calling: no stored media, a short-lived relay credential, never-logged signalling (TASK 4.1.1–4.5.1) — implemented 2026-08-27

The one Phase 4 area a DPO reviewing "what does this system process" needs named, because none of it looks like the table rows above:

- **No audio or video is ever stored.** The connection is peer-to-peer (WebRTC, D-12); Cloudflare's TURN relay (when used) forwards encrypted media packets without decrypting or storing them — this system never receives, buffers or persists a media stream at any layer.
- **The signalling payload (SDP/ICE) is treated as sensitive precisely because it can reveal device/network topology**, and is never written to a log line — proven by a dedicated test (TASK 4.2.2), the first payload in this codebase held to that standard on a log line rather than only a response body.
- **The TURN credential is a Cloudflare-issued, short-lived token** (TASK 4.4.1) — scoped to one call, never a stored secret the way a session token or API key is; nothing in this system's own data store retains it past issuance.
- **The two operational rows this phase introduces (`CONN#<connectionId>`, `CALL#<appointmentId>`/`CONN#<connectionId>`) are non-clinical, TTL-reclaimed metadata** — a connection's existence and its role, nothing about what was said or shown on the call. `connection-repository.ts`'s own header states this directly: not an entity `AuditWriter`'s `AuditAction` union needs to know about.

## Patient account creation moves to a human channel (D-29) — implemented 2026-08-29, DPIA review explicitly deferred

**Self-registration (email-OTP sign-up, TASK 2.2.3) is retired.** A patient now contacts the clinic's WhatsApp Business number; a human member of staff verifies their identity and creates their account (`docs/runbooks/patient-account-provisioning.md`). This is a genuine, new data-processing question a completed DPIA needs to cover, and it is recorded here as a placeholder rather than assessed. **Originally, the owner deferred DPIA/legal review (LL-05/LL-06) only until the mechanism was proven end-to-end against synthetic test patients** — proven, per the status update below. **D-33 (2026-08-30) extended that deferral further, by the owner's own explicit direction, to cover real patients too**, before the review itself has happened at all. Both are deliberate, informed sequencing decisions, not oversights this skeleton is papering over — but D-33's own extension carries materially more real-world exposure than the original synthetic-only deferral did, since real patient data is now genuinely at stake.

What a completed DPIA will need to weigh, named here so the DPO is not starting from nothing:

- **WhatsApp itself is outside this codebase's data flow, but not outside the patient's.** No message content, phone number, or WhatsApp identifier is stored, transmitted to, or received from any Meta system by this platform — the "integration" is a human relaying information by hand, then typing it into `POST /patients`. The DPIA question is what the *patient* discloses to Meta by using WhatsApp at all (Meta's own processing, under its own terms), which this system neither controls nor can see.
- **A password is generated and disclosed once, over WhatsApp, by a human.** It never transits email or SMS, is never logged, and is never persisted by this system beyond the single API response that creates it (`services/api/src/password-generator.ts`, `patient-admin.ts`). The DPIA's own lawful-basis table should treat this as a credential-issuance event, not a communication the platform itself sends.
- **Identity verification is now a human judgement call, not a code path.** `docs/plan/02-risk-register.md`'s new R-16 names the resulting risk (social engineering) and its mitigation (staff training) as explicitly outside what this codebase can build or audit beyond recording *which* principal acted, and *when*.
- **No new field, table, or retention basis.** The `PAT#`/`PROFILE` record this flow writes is byte-for-byte the same shape self-registration wrote — same `personal{}`/`clinical{}` split, same `pending` starting status, same append-only audit trail. Nothing about the schema-separation or audit-log sections above changes.

## Open tension — R-04 (reframed for India, D-33)

**Erasure vs C-03 (never delete patient/clinical/content/media data) is unresolved by design.** Originally framed as a GDPR erasure right; reframed by D-33 (2026-08-30) since GDPR doesn't apply here (no UK establishment). **DPDPA 2023 gives its own data-principal correction/erasure rights**, so the identical tension almost certainly recurs under Indian law instead — this has not been checked against the actual statute or its rules by anyone qualified. This is, and remains, a decision for Indian data-protection/health-law counsel (**LL-06**), not a decision the executor makes unilaterally. See `docs/plan/02-risk-register.md` (R-04).

## What real Indian counsel still needs to complete

- Confirm DPDPA 2023 (and its rules, as notified) is in fact the operative framework, and name any other Indian statute or professional-conduct rule that also applies (telemedicine practice guidelines, state medical council rules for the clinicians involved, etc.) — not assumed, not checked here.
- Lawful basis per processing activity, under whichever Indian framework applies.
- Necessity/proportionality assessment.
- The actual erasure/correction policy that resolves R-04 within C-03's constraints.
- Sign-off recorded here once complete — at which point LL-05/LL-06 in `08-long-lead.md` should be updated from "deferred by owner override" to genuinely closed.

**Do NOT** treat this skeleton as a completed DPIA or as legal advice, in any jurisdiction. **Do NOT** implement any erasure code path against this skeleton alone — that requires the sign-off above. **Do NOT** present this document to a regulator, auditor, or any third party as evidence that a completed legal review occurred — as of D-33, real patients are live on this platform with this review still outstanding, by the owner's own explicit, informed choice (`docs/plan/01-decisions.md`'s D-33).
