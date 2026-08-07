# ADR 0002 — Database

**Decision:** DynamoDB on-demand, single-table
**Options rejected:** RDS Postgres t4g.micro (~£11 + storage — over half the envelope); Aurora Serverless v2 (min ACU cost)
**£/mo:** ~£0.75
**Reversal cost:** **High** — data model is the hardest thing to reverse. Mitigated by proving every §7 query in the ADR before code
