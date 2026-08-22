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
| CloudWatch alarms | $0.80 | $0.80 | $0.80 | 8 × $0.10 |
| CloudWatch logs | $0.30 | $0.80 | $1.23 | ~2 GB @ $0.5985 + 14-day storage |
| KMS / Secrets Manager | $0 | $0 | $0 | SSE-S3 + AWS-owned keys + Parameter Store |
| EventBridge / SQS / Budgets | $0 | $0 | $0 | Within free allowances (≤2 budgets) |
| Cloudflare TURN | $0 | $0 | $0 | ≈85 GB ≪ 1,000 GB free |
| UptimeRobot / Turnstile / GitHub | $0 | $0 | $0 | Free tiers |
| **Total USD** | **$3.27** | **$8.07** | **$10.50** | |
| **Total GBP** | **£2.70** | **£6.67** | **£8.67** | |

**Headroom against the £12–14 target: £3–5/month. Against the £20 cap: £11/month.**
**After free tiers expire:** unchanged — every allowance relied on is *always-free*, not a 12-month offer. The only expiry risk is a future AWS pricing change, re-verified at each gate (§14.12).
Excluded per C-01: Stripe per-transaction fees (netted from workshop revenue); Apple $99/yr and Google $25 one-off (reported, Phase 6).
