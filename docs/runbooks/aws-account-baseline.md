# AWS account baseline — Organization + ndn-prod (TASK 0.1.1)

**Date:** 2026-08-08 · **Task:** [05-execution-plan.md § TASK 0.1.1](../plan/05-execution-plan.md) · **Decisions:** D-01, D-28

## What this covers

`803129122420` also hosts an unrelated service ("islamicmaps") and other pre-existing IAM users unconnected to this project. The goal was full account-level isolation for nourishthenerve without disturbing anything about how `803129122420`'s root is used today.

## Identity model chosen (deviates from the plan's literal step 2)

TASK 0.1.1 as written proposes IAM Identity Center (AWS SSO) with an `NDNAdmin` permission set. The account owner explicitly opted out of that in favour of keeping root access to `803129122420` completely unchanged (console + the existing long-lived CLI keys), with a **separate, account-scoped IAM user in the new account** instead of SSO. This is a deliberate, informed substitution for D-01's "access by role-switch" note — role-switch from root turned out to be impossible (see below) — not an oversight.

## What was done

1. **Enabled AWS Organizations** on `803129122420` (`aws organizations create-organization`). `803129122420` is now the management account. Feature set `ALL`; no Service Control Policies attached — root's permissions in `803129122420` are unrestricted and unchanged.
2. **Created member account `ndn-prod`** (`aws organizations create-account`), account ID **`357601815388`**, root email `mohammed.zia33+ndnprod@gmail.com`. Consolidated billing under the existing payer — one invoice, `ndn-prod` gets its own fresh free-tier allowance separate from `803129122420`/islamicmaps.
3. **Discovered and corrected an assumption:** AWS root users cannot call `sts:AssumeRole` (confirmed via direct API error: `"Roles may not be assumed by root accounts"`). This blocks console "Switch Role" too, not just CLI. So `803129122420` root can never reach `ndn-prod` via the auto-created `OrganizationAccountAccessRole` directly.
4. **Created `ndn-admin`**, an IAM user *inside `ndn-prod`* (not `803129122420`), with `AdministratorAccess` scoped to that account only, a console login (password-reset-required on first use), and a long-lived access key.
   - To create it, a short-lived bootstrap principal (`ndn-bootstrap-temp`) was created in `803129122420` with a single permission — `sts:AssumeRole` on `ndn-prod`'s `OrganizationAccountAccessRole` — used once to assume into `ndn-prod` and provision `ndn-admin`, then **fully deleted** (access key, inline policy, user) immediately after. `803129122420` was verified afterward to hold exactly the IAM users it held before (`dev-gm-server-user`, `prod-gm-server-user`, `test-user-gm`, `user-data.flightradar24`, `Zia` — none touched).
   - `ndn-admin`'s access key and console password were written directly to local files, never printed into any chat transcript: CLI credentials as a new `[ndn-prod]` profile in `~/.aws/credentials` / `~/.aws/config`, console login details originally in `~/ndn-prod-console-login.txt` (chmod 600) — since moved into the macOS Passwords app and the file deleted (see below).
5. **Verified:** `aws --profile ndn-prod sts get-caller-identity` → `arn:aws:iam::357601815388:user/ndn-admin`.

## Access model going forward

- **`803129122420`** — root, exactly as before. Covers islamicmaps and the still-live legacy nourishthenerve resources (until decommissioned at Gate G1 / TASK 1.6.1).
- **`ndn-prod` (`357601815388`)** — new platform infrastructure lands here. Reached via the `ndn-admin` IAM user: `aws --profile ndn-prod ...` for CLI, `https://357601815388.signin.aws.amazon.com/console` for the browser console. A future hire for nourishthenerve gets credentials scoped to this account only (e.g. a second IAM user here) — no path exists from this account back to `803129122420` or islamicmaps.

## GitHub OIDC provider + `ndn-deploy` role (this pass)

6. **Created the GitHub Actions OIDC identity provider** in `ndn-prod`: `arn:aws:iam::357601815388:oidc-provider/token.actions.githubusercontent.com`. The thumbprint was not copied from memory — it was fetched live from `token.actions.githubusercontent.com`'s actual TLS chain (`openssl s_client -showcerts`) and computed as the SHA-1 fingerprint of the top-of-chain CA cert presented by the server (GitHub now serves a Let's Encrypt chain, not the older DigiCert one commonly quoted in tutorials — a copied value would have been stale/wrong-length). AWS additionally auto-verifies well-known OIDC issuers like GitHub server-side, so the supplied thumbprint is not the sole safeguard.
7. **Created role `ndn-deploy`** (`arn:aws:iam::357601815388:role/ndn-deploy`), federated trust policy allowing `sts:AssumeRoleWithWebIdentity` only when `token.actions.githubusercontent.com:aud = sts.amazonaws.com` **and** `token.actions.githubusercontent.com:sub` matches `repo:nourishthenerve/ndn-monolithic:ref:refs/heads/main` or `repo:nourishthenerve/ndn-monolithic:pull_request` (ephemeral per-PR envs, per TASK 0.6.3). No other repo's OIDC token can satisfy this condition — verified by inspection of the trust policy (the `StringLike` condition is a static allowlist; a token with any other `sub` claim fails evaluation before reaching the role's permissions). An end-to-end negative test (an actual Actions run from a different repository) is deferred to TASK 0.2.1, where CI first exists to run it from.
8. **Attached AWS managed policy `PowerUserAccess`** to `ndn-deploy` — full access to build/deploy AWS resources (needed once CDK stacks exist, from TASK 0.4.1 onward) while explicitly excluding IAM user/group/role management. Verified with `iam simulate-principal-policy`:
   - `cloudformation:DescribeStacks` → `allowed`
   - `iam:CreateUser` → `implicitDeny`

   This matches TASK 0.1.1's stated test exactly. No permissions boundary was added on top — `PowerUserAccess` already excludes IAM management, and `ndn-prod` holds no resources yet for a boundary to protect; revisit if that changes.

## CloudTrail (this pass)

9. **Created S3 bucket `ndn-prod-cloudtrail-357601815388`** (eu-west-2): versioned, all four S3 public-access-block settings on, bucket policy scoped to the `cloudtrail.amazonaws.com` service principal only (`GetBucketAcl` + `PutObject` under `AWSLogs/357601815388/*`, conditioned on `bucket-owner-full-control`).
10. **Created trail `ndn-prod-management-events`**, multi-region, log file validation on, logging started. Event selector is the CloudTrail default: management events only (`ReadWriteType: All`), **no data events** — this is the free-tier configuration the task calls for; enabling S3/Lambda data events later would incur per-event cost.
11. **Verified:** `get-trail-status` → `IsLogging: true`; bucket `get-public-access-block` → all four flags `true`.

## Outstanding from TASK 0.1.1 (owner-only; cannot be scripted)

- ~~MFA on `ndn-prod`'s root user~~ — **done** (owner, 2026-08-08).
- ~~Move the temporary console password out of `~/ndn-prod-console-login.txt`~~ — **done**, saved to macOS Passwords app (owner, 2026-08-08).
- ~~Cost Explorer enablement~~ — **confirmed already active**, no opt-in step required (AWS removed the manual "Enable Cost Explorer" toggle; new accounts get the cost-and-usage dashboard by default). Verified via screenshot of the `ndn-prod` console showing the live report (all $0.00, as expected for a brand-new account).
- Root-key deletion for `803129122420` remains explicitly the owner's own action (D-28), deferred with no deadline — unaffected by anything above.

## Cost delta
£0.00 — Organization, member account, OIDC provider, IAM role, and a CloudTrail trail logging only management events (no data events) are all free. The S3 log bucket itself is free tier at this volume (a handful of small management-event objects/month).

## Rollback
- `ndn-deploy` role / OIDC provider: `aws --profile ndn-prod iam detach-role-policy` + `delete-role` + `delete-open-id-connect-provider` — nothing depends on them yet since no CI workflow exists to assume the role.
- CloudTrail: `stop-logging` + `delete-trail`; the S3 bucket (versioned) can be emptied of versions and removed separately — this is the one non-trivial reversal in this pass and is intentionally decoupled from trail deletion.
- `ndn-prod` can be closed as an AWS account if needed (Organizations console, management account). Leaving the Organization in place on `803129122420` is harmless with no SCPs attached; it can also be deleted while `ndn-prod` is the only member, if desired.
