# ADR 0002 — Database

**Decision:** DynamoDB on-demand, single-table
**Options rejected:** RDS Postgres t4g.micro (~£11 + storage — over half the envelope); Aurora Serverless v2 (min ACU cost)
**£/mo:** ~£0.75
**Reversal cost:** **High** — data model is the hardest thing to reverse. Mitigated by proving every §7 query in the ADR before code

## GSI1, proved before code (TASK 2.5.1)

`04-data-model-rbac.md`: "GSI1 clinician→patients & calendar." Two access patterns, proved against one key shape before `infra/src/data-stack.ts` added the index:

| Access pattern | Query | Proof |
|---|---|---|
| **Clinician → patients** (built at 2.5.1) | `gsi1pk = CLI#<clinicianId>` AND `begins_with(gsi1sk, 'PAT#')` | `gsi1pk`/`gsi1sk` are written on a patient's own `PAT#<id>`/`PROFILE` row (sparse: only while `assigned_clinician_id` is set), derived from that field alone by `dynamo-store.ts`'s `DynamoAssignmentStore.writeDecision` — never a second input a caller could pass out of step with it. `gsi1sk = PAT#<patientId>` |
| **Clinician calendar** (TASK 3.4.x, **not built here** — key shape checked now, per this task's own step 3, "while the index is still cheap to shape") | `gsi1pk = CLI#<clinicianId>` AND `gsi1sk BETWEEN 'APPT#<start>' AND 'APPT#<end>'` | `04-data-model-rbac.md`'s own Appointment row already names `PAT#<id>` / `APPT#<iso-utc>` as the main-table key and "GSI1 = clinician calendar" as its projection. `gsi1sk = APPT#<iso-utc>` on that same GSI1 partition sorts lexicographically = chronologically, giving a clinician's calendar a natural range query — no separate index needed for it |

Both patterns share one partition (`gsi1pk = CLI#<clinicianId>`) with different `gsi1sk` entity-type prefixes (`PAT#` vs `APPT#`), so they never collide in a query even though they share a partition — the same discipline GSI2 already uses (`KEYWORD#` vs the testimonial/workshop `_INDEX#all` projections). `KEYS_ONLY` projection: this task's own read (`listPatientIdsForClinician`) only needs the id off `gsi1sk`, and 3.4.x's future appointment reads would need a real content fetch regardless of what this index projects — a wider projection would only double storage on the largest partition for no read this plan has ever asked GSI1 to serve directly.

No `Scan` anywhere in either pattern.

## GSI3, proved before code (TASK 2.5.3)

`04-data-model-rbac.md`: "GSI3 admin cross-caseload views (FR-DP-02)." One access pattern — "every patient currently under someone's care, across every clinician, one paginated list" — the query `09-self-audit.md`'s red-team names as one of the two most likely to defeat the single-table design if it isn't proved first.

| Access pattern | Query | Proof |
|---|---|---|
| **Cross-caseload list, grouped by clinician** | `gsi3pk = 'CASELOAD#all'`, `Limit`, `ExclusiveStartKey` for the next page | `gsi3pk`/`gsi3sk` are sparse attributes on the patient's own `PAT#<id>`/`PROFILE` row, set only while `account_status === 'approved'` — a pending or declined patient isn't part of anyone's caseload, so it never carries either attribute (step 3's "only rows that belong in an admin view carry `gsi3pk`"). `gsi3sk = CLI#<assignedClinicianId>#PAT#<patientId>`, written by the same `DynamoAssignmentStore.writeDecision` call that already derives GSI1's projection from `assigned_clinician_id` — one write, three index attributes, no second input to fall out of step. Sorting by clinician first means one `Query` returns the whole cross-caseload list already grouped exactly as a "which patients does each clinician have" admin view wants it, with no client-side grouping and no second query per clinician |

Deliberately **one fixed partition value**, the same "`_all`" shape `TESTIMONIAL_INDEX_GSI2PK`/`WORKSHOP_INDEX_GSI2PK` already use on GSI2 for their own "list everything of this type" pattern — reused here as its own named index (GSI3, not GSI2) because `04-data-model-rbac.md` names GSI3 for this pattern specifically, from the plan's own first draft, and patients are the table's largest-volume entity by a wide margin: keeping the admin cross-caseload pattern on its own index means a future GSI2 change (content keywords, testimonials, workshops) can never accidentally touch this one's capacity or projection shape.

`KEYS_ONLY` projection: the read (`caseload-repository.ts`'s `listPage`) only needs the id off `gsi3sk`, then follows up with one `GetItem` per patient on the current page — the same "index returns ids, repository fetches the page" shape `testimonial-repository.ts`'s `findByStatus`/`workshop-repository.ts`'s own list reads already use for GSI2. Never accumulated in memory across pages (step 5): each page is one bounded `Query` plus up to `Limit` `GetItem`s, never a scan of the whole caseload to filter client-side.

No `Scan` anywhere in this pattern.

### Amendment, 2026-08-31 — GSI3 became the patient directory

The row above is superseded, not deleted: the sparse-on-assignment shape it proves is exactly what the principal's dashboard could not use. The owner asked for "an overall dashboard showing how many patients are there in the system with active ones being at the top", and a sparse index answers neither half — a just-registered `pending` patient, the one row the principal opens the page to act on, carried no `gsi3pk` at all, so no query could reach them.

| Access pattern | Query | Proof |
|---|---|---|
| **Whole patient directory, active first, grouped by clinician within a status** | `gsi3pk = 'CASELOAD#all'`, `Limit`, `ExclusiveStartKey` | `gsi3pk`/`gsi3sk` are now on **every** patient's `PAT#<id>`/`PROFILE` row, derived by one exported function (`patientDirectoryIndexAttributes`, dynamo-store.ts) that all three writers of that row call. `gsi3sk = <rank>#CLI#<assignedClinicianId \| UNASSIGNED>#PAT#<patientId>`, where `rank` is `0` approved / `1` pending / `2` suspended / `3` declined. Ordering is therefore the index's own — the read side sorts nothing, and "active at the top" holds across pages, not merely within one |
| **How many patients, and how many active** | `gsi3pk = 'CASELOAD#all'` with `Select: 'COUNT'`; the same again with `begins_with(gsi3sk, '0#')` | Two counting Queries on a `KEYS_ONLY` index, on the first page of a listing only (`caseload-repository.ts`). No counter attribute to keep consistent, no `Scan`, and nothing to drift from the rows it counts |

The `#PAT#` marker is unchanged, so `DynamoCaseloadStore.queryPage`'s existing parse (everything after the last `#PAT#`) still recovers the patient id; `UNASSIGNED` is a literal that cannot collide with a clinician id (a Cognito `sub`). GSI1 stays sparse and unchanged — it answers "which patients are *this clinician's*", a question an unassigned patient genuinely has no answer to.

Rows written before this date carry the old projection or none, and no index rewrites itself: `scripts/backfill-directory-index.mjs` is the one-shot correction, and the one place in this repo a `Scan` is sanctioned (it is a maintenance job, not a request path — see its own header).

## GSI2's third fixed partition, 2026-08-31 — the clinician directory

`GET /clinicians` needs "every clinician, whatever their status", and nothing indexed one. The `CLI#<id>`/`PROFILE` row now carries `gsi2pk = 'CLINICIAN_INDEX#all'` / `gsi2sk = CLI#<id>`.

| Access pattern | Query | Proof |
|---|---|---|
| **Whole clinician directory** | `gsi2pk = 'CLINICIAN_INDEX#all'`, then one `GetItem` per row | The same `_all` fixed-partition shape `TESTIMONIAL_INDEX#all`/`WORKSHOP_INDEX#all` already use on GSI2, and it collides with neither those nor a content keyword's `KEYWORD#...`. Unpaginated by design: a clinician directory is a handful of people, and `LastEvaluatedKey` is still followed so "a handful" being wrong is a slower call, never a silently truncated list |

Unlike the testimonial and workshop projections, the keys go on the `PROFILE` row itself rather than a separate `INDEX` row: a clinician's projection is a pure function of `item.id`, so both writers (`create`, `update`) derive it identically and there is nothing a second row would protect against. `KEYS_ONLY`, same as every other index on this table.

No `Scan` in either of the two patterns above. The pre-existing rows are, again, `scripts/backfill-directory-index.mjs`'s job.

## GSI4, proved before code (TASK 3.4.3) — removed, D-32 (2026-08-30)

**GSI4 no longer exists.** The reminder sweep it existed for is deleted outright — the owner's own words: "remove this reminder thing, the clinician handling whatsapp will send a reminder manually." This section's proof is kept, unedited, as the historical record of why the index looked the way it did while it existed; `infra/src/data-stack.ts` no longer calls `addGlobalSecondaryIndex` for it, `Appointment.reminder_sent_at` no longer exists on the type, and this table now has three GSIs, not four. Full reasoning: [01-decisions.md](../plan/01-decisions.md)'s D-32, [docs/runbooks/appointment-reminders.md](../runbooks/appointment-reminders.md).

`04-data-model-rbac.md`: "GSI4 appointment-window lookups for reminders" — named since the plan's first draft, never built until now. One access pattern, with no natural per-clinician or per-patient partition (unlike GSI1/GSI3's fixed-actor patterns): "every scheduled, not-yet-reminded appointment starting in roughly the next hour, across every clinician and patient."

| Access pattern | Query | Proof |
|---|---|---|
| **Reminder sweep window** | `gsi4pk = 'APPT#REMINDER'` AND `gsi4sk BETWEEN '<windowStart-iso>' AND '<windowEnd-iso>'` | `gsi4pk`/`gsi4sk` are sparse attributes on the appointment's own `PAT#<id>`/`APPT#<scheduledAt>` row, set once at creation — only while `appointment_status === 'scheduled'` and `scheduledAt` is later than `created_at` (a proxy for "in the future," checked at write time without a second clock dependency in the store). `gsi4sk = <iso-utc>#<patientId>` — `scheduledAt` first so the partition sorts chronologically, `patientId` appended only to keep the key unique across two patients who happen to share an exact instant (`04-data-model-rbac.md`'s own shape). `TASK 3.4.2`'s `cancel` never touches `gsi4pk`/`gsi4sk` — a cancelled appointment stays a real, findable GSI4 row; excluding it from a live sweep is the read's own job (below), the same division TASK 3.4.2 already established for GSI1's calendar read against the same cancelled-row case |

One fixed partition value (`'APPT#REMINDER'`), the same `_all`-shape precedent `GSI3_CASELOAD_PK`/`TESTIMONIAL_INDEX_GSI2PK`/`WORKSHOP_INDEX_GSI2PK` already establish for "one query needs to see everything of this type, with no natural per-entity partition to scope by instead."

`KEYS_ONLY` projection, the same choice GSI1/GSI3 both make — and here it forces a real consequence worth stating plainly: `appointment_status` and `reminder_sent_at` are **not** projected into GSI4, so neither can appear in a `FilterExpression` evaluated against the index itself (DynamoDB filters a `Query`'s results using only the attributes the index actually stores; a condition naming an unprojected attribute is not an error, but it can never distinguish one item from another, since the index holds none of them). The sweep's own exclusion of an already-reminded or now-cancelled candidate is therefore an **application-level check after a follow-up `GetItem`** — the identical "index gives candidates, the read confirms them" two-step shape `DynamoCaseloadStore.queryPage` (GSI3) and `DynamoAppointmentStore.listForClinicianCalendar` (GSI1, TASK 3.4.2's cancelled-row exclusion) already use, for the identical reason. (TASK 3.4.3's own plan text describes this step as "a `FilterExpression`... excludes already-reminded rows" — read here as the general, informal sense of "a filter after the query," not literally DynamoDB's `FilterExpression` parameter, which a `KEYS_ONLY` index cannot support for this purpose.)

No `Scan` anywhere in this pattern.
