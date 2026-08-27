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

## Open tension — R-04

**GDPR erasure vs C-03 (never delete patient/clinical/content/media data) is unresolved by design.** This is a decision for your DPO/solicitor (**LL-06**), not a decision the executor makes unilaterally. See `docs/plan/02-risk-register.md` (R-04).

## What the DPO still needs to complete

- Lawful basis per processing activity.
- Necessity/proportionality assessment.
- The actual erasure policy that resolves R-04 within C-03's constraints.
- Sign-off recorded here once complete.

**Do NOT** treat this skeleton as a completed DPIA. **Do NOT** implement any erasure code path against this skeleton alone — that requires the sign-off above.
