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
