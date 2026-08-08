# AWS account baseline — Organization + ndn-prod (TASK 0.1.1, partial)

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
   - `ndn-admin`'s access key and console password were written directly to local files, never printed into any chat transcript: CLI credentials as a new `[ndn-prod]` profile in `~/.aws/credentials` / `~/.aws/config`, console login details in `~/ndn-prod-console-login.txt` (chmod 600) — that file should be moved into a password manager and deleted.
5. **Verified:** `aws --profile ndn-prod sts get-caller-identity` → `arn:aws:iam::357601815388:user/ndn-admin`.

## Access model going forward

- **`803129122420`** — root, exactly as before. Covers islamicmaps and the still-live legacy nourishthenerve resources (until decommissioned at Gate G1 / TASK 1.6.1).
- **`ndn-prod` (`357601815388`)** — new platform infrastructure lands here. Reached via the `ndn-admin` IAM user: `aws --profile ndn-prod ...` for CLI, `https://357601815388.signin.aws.amazon.com/console` for the browser console. A future hire for nourishthenerve gets credentials scoped to this account only (e.g. a second IAM user here) — no path exists from this account back to `803129122420` or islamicmaps.

## Outstanding from TASK 0.1.1 (not done in this pass)

- **MFA on `ndn-prod`'s root user** — requires an interactive browser + authenticator app step; cannot be scripted. Owner action.
- **Move the temporary console password out of `~/ndn-prod-console-login.txt`** into a password manager, then delete the file. Owner action.
- **GitHub OIDC provider + `ndn-deploy` role** in `ndn-prod`, scoped to `repo:nourishthenerve/ndn-monolithic` — needed before CI (TASK 0.2.1) can deploy.
- **CloudTrail + Cost Explorer** enablement in `ndn-prod`.
- Root-key deletion for `803129122420` remains explicitly the owner's own action (D-28) and is unaffected by anything above — this pass didn't touch it and doesn't require it.

## Cost delta
£0.00 — a new Organization and member account carry no charge by themselves.

## Rollback
`ndn-prod` can be closed as an AWS account if needed (Organizations console, management account). Leaving the Organization in place on `803129122420` is harmless with no SCPs attached; it can also be deleted while `ndn-prod` is the only member, if desired.
