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
