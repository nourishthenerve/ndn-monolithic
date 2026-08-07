# 11. Plan self-audit

- **Coverage:** every FR/NFR maps to ≥1 task and ≥1 test; every risk R-01…R-14 has a named mitigating task. FR-WEB-03 is the sole uncovered requirement, deliberately, by D-05.
- **Ordering:** the dependency graph is acyclic — checked by walking every task's `Depends on` and confirming each names only lower-numbered tasks. Guards (0.3.x) precede all data writes; the SMS cap (0.5.3) precedes any send; canary/rollback (0.6.2) precedes user-facing features. After every task the tree builds and production works; incomplete work merges dark behind flags.
- **Cost roll-up:** £8.00/month at M12 against a £12–14 target and £20 cap — **£4–6 headroom to target, £12 to cap.** No line depends on an expiring free tier.
- **`UNVERIFIED` prices:** .com renewal · AWS UK SMS unit price · Cloudflare TURN free-tier period · Vonage UK SMS · MEF lead time · Apple GBP fee · EBS gp3 + IPv4. Each re-verified at G0 and every 90 days (§14.12).

**Red-team — the five likeliest ways this plan fails:**

1. **SMS arithmetic bites at scale.** 500 patients × weekly reminders ≫ 108 messages. *Changed:* email-primary from day one, SMS behind a proven hard block, degradation defined before launch, push prioritised in Phase 6.
2. **The private-field boundary leaks through a path nobody tested** — an export, a log line, an error message, a cache. *Changed:* enforcement moved to a single repository-layer projection rather than per-handler, 100% coverage on that chokepoint, and a re-audit *from scratch* at every gate rather than only when the code changes.
3. **DynamoDB single-table design meets a §7 query it can't serve** (admin cross-caseload views, keyword matching) and forces a costly migration mid-build. *Changed:* ADR-002 must prove every §7 query against the key schema **before** any table code is written, and names the fallback explicitly.
4. **Zero staging plus a bad merge takes production down** in front of patients. *Changed:* five independent layers — contract tests, ephemeral PR environments, dark merges behind flags, canary with automatic rollback, and post-deploy smoke — with rollback *demonstrated* at G0, not documented.
5. **Cost creeps invisibly** — log volume, an unmetered path, a retained-media surprise — and the cap is breached before anyone notices. *Changed:* budgets and alarms land in Phase 0 *before* anything can spend, 14-day log retention is a CDK default rather than a habit, and every gate reconciles actual spend against this model across the whole envelope, not just AWS.

**Where I'd push back on the brief (§16.8):** §11 places the entire public website (Phase 1) before any identity or authorisation work (Phase 2). That defers the authorisation boundary — the component where a mistake is most catastrophic and most expensive to retrofit — until after five milestones of accumulated momentum, while front-loading the surface with the least clinical risk. I have **not** silently reordered. I recommend pulling M2.3 (RBAC enforcement layer + audit log) forward to sit alongside M1.1, so the spine exists and is exercised for the whole of Phase 1 before real patients exist. Your call at G1.
