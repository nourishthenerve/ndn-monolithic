# ADR 0001 — Compute

**Decision:** Lambda arm64 + HTTP API
**Options rejected:** Always-on t4g.small (~£12, fails cap + no zero-downtime story); Fargate (~£25)
**£/mo:** ~£0.48
**Reversal cost:** Low — handlers are framework-light
