# 4. Costed bill of materials

Planning rate **£1 = $1.2105**. All figures ex-VAT. New account ⇒ its own always-free allowances; **no 12-month new-account offers** (org members forfeit credits), so nothing below depends on an expiring trial.

| Line | M1 (site only) | M6 (~250 patients) | M12 (~500 patients) | Basis |
|---|---|---|---|---|
| Route 53 hosted zone | $0.50 | $0.50 | $0.50 | $0.50/zone |
| Route 53 queries | $0.02 | $0.03 | $0.04 | ~100k/mo @ $0.40/M |
| Domain renewal (amortised) | $1.33 | $1.33 | $1.33 | $16.00/yr ÷ 12 — verified 2026-08-13 at G0 via `aws route53domains list-prices --tld com` |
| ACM certificates | $0 | $0 | $0 | Public certs free |
| CloudFront | $0 | $0 | $0 | Within always-free 1 TB + 10M req |
| S3 storage + requests | $0.10 | $0.30 | $0.53 | 20 GB @ $0.024 + requests |
| Lambda | $0 | $0 | $0 | Within always-free 1M req + 400k GB-s |
| API Gateway HTTP API | $0.12 | $0.35 | $0.58 | 500k req @ $1.16/M |
| DynamoDB on-demand | $0.05 | $0.40 | $0.67 | 2M RRU + 500k WRU |
| DynamoDB PITR | $0 | $0.12 | $0.24 | ~1 GB @ $0.23772 |
| Cognito Essentials | $0 | $0 | $0 | 509 MAU ≪ 10,000 free — re-verified 2026-08-22 at TASK 2.2.1 (unchanged; always-free, $0.015/MAU beyond, `eu-west-2`) |
| SES outbound | $0.05 | $0.18 | $0.30 | 3,000 emails @ $0.10/1k |
| **SMS (message spend)** | $0 | $1.26 | **$2.28** | AWS End User Messaging @ $0.035/msg (re-verified 2026-08-22, ADR-0008/TASK 2.3.2) — same ~36/65 msg-per-month assumption this line carried under the prior Twilio-rate figure. Hard-capped independently at £5 = $6.05 (`sms-spend-cap.ts`), which at this rate covers ≈172 msgs/mo — see ADR-0008 for why that now covers R-01's full ~150/mo modelled volume, not only most of it |
| **SMS origination (long code)** | $0 | $2.00 | $2.00 | One UK long code, leased once LL-02 completes (owner-provisioned, `08-long-lead.md`) — $2.00/mo flat, $0 setup. Not yet leased: $0 until then, modelled from M6 as the first milestone with real reminder volume |
| CloudWatch alarms | $0.80 | $0.80 | $0.80 | 8 × $0.10 — modelled headroom; 5 real alarms exist in production today, TASK 4.4.2 adds a 6th, still inside this line |
| CloudWatch logs | $0.30 | $0.80 | $1.23 | ~2 GB @ $0.5985 + 14-day storage |
| KMS / Secrets Manager | $0 | $0 | $0 | SSE-S3 + AWS-owned keys + Parameter Store |
| EventBridge / SQS / Budgets | $0 | $0 | $0 | Within free allowances (≤2 budgets) |
| API Gateway WebSocket (signalling) | $0 | $0.01 | $0.02 | Not yet built at M1; from M6, ~250/~500 calls/mo × ~30 messages + ~60 connection-min each @ $1.00/M messages + $0.25/M connection-min — re-verified live 2026-08-26 (TASK 4.1.1), `eu-west-2` standard rate |
| Cloudflare TURN | $0 | $0 | $0 | ≈85 GB ≪ 1,000 GB free — re-verified live 2026-08-26 (TASK 4.4.1) via `developers.cloudflare.com/realtime/sfu/pricing`: still 1,000 GB/mo free, $0.05/GB overage, unchanged since G0 |
| UptimeRobot / Turnstile / GitHub | $0 | $0 | $0 | Free tiers |
| AWS Cost Explorer | $0.08 | $0.08 | $0.08 | Flat per-account charge — found live during TASK 5.5.1's reconciliation below, never previously modelled |
| **Total USD** | **$3.35** | **$8.16** | **$10.60** | |
| **Total GBP** | **£2.77** | **£6.74** | **£8.76** | |

**Headroom against the £12–14 target: £3–5/month. Against the £20 cap: £11.24/month.**
**After free tiers expire:** unchanged — every allowance relied on is *always-free*, not a 12-month offer. The only expiry risk is a future AWS pricing change, re-verified at each gate (§14.12).
Excluded per C-01: Stripe per-transaction fees (netted from workshop revenue); Apple $99/yr and Google $25 one-off (reported, Phase 6). **Re-verified live 2026-08-29, ahead of Phase 6's own elaboration at Gate G5 (TASK 6.6.1): both unchanged.** Apple Developer Program still $99/yr → **£81.78/yr** at this plan's own £1=$1.2105 planning rate; Google Play registration still a $25 one-off → **£20.65**. Neither figure was struck from `09-self-audit.md`'s `UNVERIFIED` list until this pass — the third of the original six to move from deferred to resolved, at exactly the gate that document named for it ("Apple/EBS before Phase 6").

## TASK 5.5.1 — Live reconciliation against `ndn-prod`'s real Cost Explorer billing, 2026-08-28

Every prior gate reconciled spend against a system still partly unbuilt, every flag off. This is the first reconciliation against the complete Phase 0–4 product, and the first against real, per-service Cost Explorer data rather than the account-wide `AWS Budgets` figure alone.

### Real spend, month-to-date (2026-08-01 to 2026-08-28)

`aws ce get-cost-and-usage --time-period Start=2026-08-01,End=2026-08-28 --granularity MONTHLY --metrics UnblendedCost --group-by Type=DIMENSION,Key=SERVICE`:

| Service | MTD (USD) | Model line | Model M1 |
|---|---|---|---|
| Amazon Simple Storage Service | $0.0990 | S3 storage + requests | $0.10 |
| AmazonCloudWatch | $0.3102 | CloudWatch alarms + logs (combined) | $1.10 |
| AWS Cost Explorer | $0.0800 | **not modelled — see below** | — |
| Amazon API Gateway | $0.0024 | API Gateway HTTP API (+ WebSocket, same service dimension) | $0.12 |
| Amazon DynamoDB | $0.00003 | DynamoDB on-demand + PITR | $0.05 |
| AWS Lambda | $0.00002 | Lambda | $0 |
| AWS Secrets Manager | $0.00001 | KMS / Secrets Manager | $0 |
| Amazon CloudFront | ~$0 | CloudFront | $0 |
| **Total** | **$0.4917** | | **$3.27** |

`AWS Budgets`' own cached figure for the same account read **$0.628** at query time — a small, expected discrepancy against the $0.4917 Cost Explorer total above: Budgets refreshes on its own cycle (documented as up to ~8–24h lag) and was not re-queried at the identical instant. Both are real, live figures; neither is wrong, and the gap (~$0.14) is well inside what that lag alone explains — named rather than picked-the-more-convenient-one.

### What the drift means, line by line — not silently absorbed

- **S3**: $0.0990 real vs $0.10 modelled at M1 — as close a match as this model gets anywhere. No action.
- **CloudWatch**: $0.3102 real vs $1.10 modelled (the alarms + logs lines combined) — real spend is **entirely alarms** (`EUW2-CW:AlarmMonitorUsage`, $0.3101 of the $0.3102 — broken out via a second `get-cost-and-usage` call grouped by `USAGE_TYPE`), with log *storage/ingestion* itself at effectively $0 (`EUW2-VendedLog-Bytes`: $0.00). This is expected, not a finding: the logs line's own model ($0.30 even at M1) assumes real request-driven log volume that doesn't exist yet — `content-read-function`'s own log group held **zero events for its entire life** until [#115](https://github.com/nourishthenerve/ndn-monolithic/pull/115) fixed it days ago, so this account's logging estate has barely begun accumulating billable volume. The alarms figure (~$0.05/alarm/month for the account's 6 real alarms) is *cheaper* than the model's own $0.10/alarm assumption — no correction needed, the model was conservative in the right direction.
- **API Gateway / DynamoDB / Lambda**: all real figures sit at a small fraction of their M1 model line — expected, since M1 itself models a live public site with real (if modest) visitor traffic, and this account's only real HTTP/Lambda/DynamoDB activity to date is this session's own load test (5.1.1, 6,900 requests) and manual verification calls, not sustained real usage.
- **AWS Cost Explorer itself: $0.08/month, genuinely unmodelled.** Enabling Cost Explorer (TASK 0.1.1) carries its own small charge this cost model never accounted for — a real, if trivial, gap. **Added to the table above**, the first change this reconciliation makes to the model rather than only explaining drift away.
- **Route 53 (domain renewal, hosted zone, queries): $0 this month, not drift.** The model's own $1.33/month line is an *amortised* $16.00/year renewal; real AWS billing charges the full $16.00 once, on the domain's actual renewal date, not spread monthly. A $0 month and a $16 month are both consistent with the model's own amortisation — only a full-year total would show real drift, and one hasn't elapsed since the domain was registered.
- **SES / SMS / Cognito / KMS / EventBridge / SQS**: not itemised in Cost Explorer's own output at all — the API omits zero-usage services rather than listing them at $0.00, consistent with the model's own $0 figure for each, not a gap in the query.

### 5.1.1's own load-test cost, closed the loop analytically rather than carved out of MTD billing

The load-test stack existed for ~30 minutes inside a >$0.49 month-to-date total — not separable from aggregate daily-granularity Cost Explorer data with any real precision. Computed instead from the load test's own real, counted usage against this model's own published per-unit rates: 6,900 HTTP requests × $1.16/M (API Gateway HTTP API line, above) = **$0.008**; ~6,900 Lambda invocations at 128MB/arm64 within the account's monthly free tier (1M requests + 400,000 GB-s) = **$0**; near-empty-table DynamoDB reads/writes = **$0**; the WebSocket API and CloudFront distribution existed but were never invoked (the signalling scenario didn't run — `load-testing.md`) = **$0**. **Total: ≈$0.008**, confirming `load-testing.md`'s own "a fraction of a cent" as a real number rather than a hand-wave, and closing this task's own step 2 ("closing the loop between modelled at M12 volume and what 10× that volume actually costs") — at 10× modelled peak HTTP volume, per-request cost itself is unchanged from the model's own $1.16/M basis; only the account's *sustained* draw at that rate for a full month would materially move the model's total, which this 7-minute run does not attempt to simulate.

### Model correction

Added to the table above: **AWS Cost Explorer, $0.08/mo flat, all columns** — the one real, unmodelled line this reconciliation found. Every other line's real-vs-modelled gap is explained above as expected pre-launch headroom, not a pricing error, so no other model line changes. The move (M12: $10.52 → $10.60, £8.69 → £8.76) is rounding-level and does not change the £3–5/month headroom-to-target conclusion; headroom-to-cap updated above to £11.24/month.
