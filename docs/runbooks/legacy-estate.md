# Legacy estate — findings and containment (TASK 0.0.2)

**Account:** `803129122420` (eu-west-2) · **Date:** 2026-08-08 · **Task:** [05-execution-plan.md § TASK 0.0.2](../plan/05-execution-plan.md)

Note: account `803129122420` also hosts an unrelated service ("islamicmaps"). Nothing in this task touched any resource outside `nourishthenerve*`.

## What was there

- **S3 bucket `nourishthenerve`** (eu-west-2), versioning **disabled**, no bucket policy, public access block fully enabled (bucket itself is not publicly reachable — only via the Lambda's role). Two prefixes: `clients/` (16 objects — per-client media/report assets, keyed by numeric client ID, e.g. `clients/99999999/...`) and `posts/` (1 object — a blog markdown file).
- **Lambda `nourishthenerve-api`** (Python 3.11, FastAPI + Mangum), execution role `nourishthenerve-api-role-56voptv0`, with a **public Function URL** (`AuthType: NONE`, resource policy `Principal: "*"`) at `https://sb4mceirihlywqslzljk35tucu0patni.lambda-url.eu-west-2.on.aws/`.
- **`LambdaS3AccessPolicy`** (customer-managed IAM policy, attached to the Lambda's role) granted `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket` on the whole bucket — i.e. the public, unauthenticated Function URL had a code path to a role that could delete any object in an unversioned bucket. This is risk **R-06** in the risk register.

## Does the live brochure site depend on the Function URL?

Yes — confirmed by reading `js/script.js` served from `https://nourishthenerve.com/`:

- `POST {function-url}/form` — the contact form submit handler.
- `GET {function-url}/client/{id}/report` — a "client report" lookup, triggered by a form on the public site asking for a "Client ID".

Because of this dependency, per the task's instructions the Function URL was **kept**, not deleted (full decommission is deferred to TASK 1.6.1 / Gate G1). CORS was restricted instead (see below).

**Two pre-existing issues found while confirming this, out of scope for this task but flagged for follow-up:**

1. **No `/form` route exists in the deployed Lambda code** (`main.py`) — only `/`, `/health`, and `/client/{client_id}/report` are wired up. The contact form's `POST /form` call 404s today; the contact form is silently broken on the live site. Not fixed here — no code in this repo yet deploys to this Lambda.
2. **`/client/{client_id}/report` has no authentication or authorization** — any numeric ID returns that client's report page (media, audio, files) via `s3:GetObject`/presigned URLs. This is an unauthenticated-enumeration exposure of client data, closer to risk R-09 territory. Read-only access to `clients/` remains after this task's changes (removing Put/Delete does not fix this), so the exposure is unchanged by TASK 0.0.2. This needs a real fix (auth) before Gate G1 — tracked as a gap against R-06/R-09, not resolved here.

## Changes made

### 1. S3 bucket versioning

```bash
aws s3api put-bucket-versioning --bucket nourishthenerve --versioning-configuration Status=Enabled
```

Verified: `aws s3api get-bucket-versioning --bucket nourishthenerve` → `{"Status": "Enabled"}`. Deletes/overwrites are now recoverable; no data was touched.

### 2. `LambdaS3AccessPolicy` — removed Put/Delete

Read the deployed Lambda source (`main.py`) directly from the function's code package to confirm safety before changing the policy: the only `s3:PutObject` call site is `_save_blog_to_s3`, used solely by the `POST /blog/{slug}` route, which is **commented out** — dead code. No `s3:DeleteObject` call exists anywhere in the code. So removing Put/Delete breaks nothing currently live.

New policy version (`v2`, set as default):

```json
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "BlogBucketReadOnly",
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:ListBucket"],
            "Resource": ["arn:aws:s3:::nourishthenerve", "arn:aws:s3:::nourishthenerve/*"]
        }
    ]
}
```

Previous version (`v1`, with Put/Delete) retained, non-default, for rollback.

**Verification (IAM policy simulator against the live role), 2026-08-08:**

| Action | Decision |
|---|---|
| `s3:GetObject` | `allowed` |
| `s3:PutObject` | `implicitDeny` |
| `s3:DeleteObject` | `implicitDeny` |

### 3. Function URL CORS restricted

Was `AllowOrigins: ["*"]`. Changed to:

```json
{
  "AllowOrigins": ["https://nourishthenerve.com", "https://www.nourishthenerve.com"],
  "AllowMethods": ["GET", "POST"],
  "AllowHeaders": ["content-type"],
  "AllowCredentials": false
}
```

`AuthType` remains `NONE` and the resource policy is unchanged (`Principal: "*"`) — CORS only constrains browser-enforced cross-origin calls, it does not add authentication. The Function URL is still directly invocable (e.g. via curl) by anyone with the URL. Full decommission/auth is deferred to Gate G1 per the plan; this is the interim containment the task calls for.

## Regression check

- `curl -sI https://nourishthenerve.com/` → `200` (brochure site unaffected)
- `GET {function-url}/health` → `200`
- `GET {function-url}/client/99999999/report` (with `Origin: https://nourishthenerve.com`) → `200` (read path, driven by `GetObject`/presigned URLs, unaffected by the Put/Delete removal)

## Cost delta

£0.00 — no new billable resources; S3 versioning has no cost impact on existing object volume at this scale.

## Rollback

- **Policy:** `aws iam set-default-policy-version --policy-arn arn:aws:iam::803129122420:policy/LambdaS3AccessPolicy --version-id v1`
- **CORS:** re-run `aws lambda update-function-url-config` with `AllowOrigins: ["*"]`.
- **Versioning:** left enabled — per the plan, versioning is never harmful and is not rolled back.

## Not done in this task (explicitly out of scope)

- The Function URL was **not** deleted (site depends on it).
- The Lambda was **not** deleted (prohibited until TASK 1.6.1).
- No S3 objects were deleted, moved, or modified.
- The unauthenticated `/client/{id}/report` exposure and the broken `/form` route were **not** fixed — flagged above for a future task.

## Decommission — executed 2026-08-15 (supersedes the "not done" list above)

**Owner instruction, in session:** all legacy `nourishthenerve` infrastructure in `803129122420` is to be removed except Route 53 and DNS. This ran **ahead of** the TASK 1.6.1 step 6/7 ordering (cutover → 24–48h observation → delete), which is a deliberate, recorded deviation — see "Why running early was safe" below.

### Deleted

| Resource | Detail |
|---|---|
| Lambda Function URL | `https://sb4mceirihlywqslzljk35tucu0patni.lambda-url.eu-west-2.on.aws/` — the R-06 public unauthenticated surface |
| Lambda `nourishthenerve-api` | python3.11, last modified 2026-02-24 |
| Log group `/aws/lambda/nourishthenerve-api` | 46 KB, had **infinite** retention |
| IAM roles (5) | `nourishthenerve-api-role-{56voptv0,fzndil2c,h17jvt8x}`, `nourishthenerve-sms`, `nourishthenerver-api-role-tr6wn6xp` (note the typo'd name — an abandoned duplicate, never used) |
| IAM policies (6) | `LambdaS3AccessPolicy` (both versions), four `AWSLambdaBasicExecutionRole-*` service-role policies, `Cognito-1769082610319` — each verified at `AttachmentCount: 0` before deletion |

**Not touched, deliberately:** the Route 53 zone and every DNS record (owner instruction, and the G1 cutover still needs them); the S3 bucket `nourishthenerve` (D-03 — see "Still outstanding"); everything `islamicmaps*`; the `mariamzia.com` bucket; the shared `aws-sam-cli-managed-*` bucket.

### Why running early was safe

The TASK 1.6.1 gate exists so the legacy site is never broken before the new one serves the apex. Its purpose was met by evidence rather than by sequence:

- **Traffic:** `cloudwatch get-metric-statistics` over the preceding 30 days returned a single datapoint — **2 invocations, both on 2026-08-07**, the date of this project's own Stage A discovery probes. No real user traffic at all, which is a stronger signal than the planned 24–48h post-cutover window would have produced.
- **Blast radius:** the legacy static site is **not** served from this account. `list-buckets` confirms the `nourishthenerve` bucket holds only `clients/` and `posts/` — no HTML, no site assets — so the brochure site's origin is in the third account serving `d2z3fclxq13w3z.cloudfront.net`. Verified after deletion: apex `302` → `www`, `www` `200`, still serving.
- **What did break, intentionally:** the legacy site's two API calls. `POST /form` was already dead (`legacy-estate.md` found no such route — it 404'd). `GET /client/{id}/report` now fails; it had no authentication and served any client's media to any numeric ID, so removing it *is* the fix.

### What this resolves

- **R-06 closed.** The public delete-capable Lambda is gone, not merely contained as in TASK 0.0.2.
- **The unauthenticated `/client/{id}/report` enumeration exposure is gone.** TASK 1.6.1 step 9 required this to be fixed or formally accepted before decommissioning, and warned it must not be "silently carried forward again" if the cutover slipped. The cutover has slipped indefinitely onto an AWS support queue with no SLA, so it was closed by removal instead of left live.
- The broken `/form` route is gone with it.

### Still outstanding — the S3 bucket

The bucket `nourishthenerve` (17 objects, 361 MB) is **not** deleted. It is now fully inert — the only role that could read it no longer exists — so it is unreachable by anything, costing roughly £0.01/month.

Its contents are, on inspection, entirely test data: a single `clients/99999999/` prefix (a placeholder ID) holding generic sample files (`file_example_MP3_5MG.mp3`, `file_example_MP4_1920_18MG.mp4`), an unrelated programming textbook PDF, four `download*.{jpeg,png,webp}` images, a downloaded YouTube video about rainfall, and a 1.3 KB `response.md`; plus a 29-byte `posts/first-post.md`. **No real client or clinical data is present.**

Even so, **D-03 forbids deleting this bucket or its prefixes "under any circumstance,"** and that prohibition is the spine of the whole data-protection design (§6.7, R-06, the destructive-primitive lint rule, the IAM deny guardrails). Deleting it therefore needs an explicit, recorded owner decision overriding D-03 — not an inference from "remove the legacy estate." Left in place pending that decision.

### Backup taken before deletion

The Lambda's deployment package was downloaded and its source (`main.py`, 673 lines) preserved at `~/Desktop/nourishthenerve/legacy-lambda-main.py`, outside this repo. Scanned before deletion: no credentials or secrets embedded; routes confirmed as `/`, `/health`, `/client/{client_id}/report`, with the blog routes commented out — matching what this runbook documented in February.
