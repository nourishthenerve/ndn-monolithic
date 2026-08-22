# The two Cognito user pools (TASK 2.2.1)

**Date:** 2026-08-22 · **Task:** [05-execution-plan.md § TASK 2.2.1](../plan/05-execution-plan.md) · **Milestone:** M2.2 · **Requirements:** NFR-03, NFR-04 · **Decisions:** D-09, [ADR-0004](../adr/0004-auth.md) · **Risks:** R-07 · **Depends on:** 2.1.1

## The invariant

> No clinician can exist without TOTP. No patient is asked for a second factor. A patient credential cannot become a clinician credential, because the two are not in the same directory. Neither directory can be deleted by the role that deploys it.

## Step 1 first: the price, re-verified

D-09 priced Cognito at £0 on a figure verified **2026-08-07**, and the gate checklist requires re-verification past 90 days. This task is the first that actually depends on it, so it was re-verified on **2026-08-22** before anything was built — 15 days inside the window, done anyway because a task that says "re-verify first" and then doesn't is how a stale number survives.

| What | Value | Source |
|---|---|---|
| Essentials free allowance | **10,000 MAU/month**, per account **or per AWS organization** | [aws.amazon.com/cognito/pricing](https://aws.amazon.com/cognito/pricing/) |
| Is it always-free? | Yes — "The free tier does not automatically expire at the end of your 12-month AWS Free Tier term, and it is available to both existing and new AWS customers indefinitely" | same page |
| Essentials price beyond it, `eu-west-2` | **$0.015/MAU**, flat, one tier | usage type `EUW2-CognitoEssentialsMAU` in the AWS Price List |
| Modelled load | 509 MAU at M12 | [03-cost-model.md](../plan/03-cost-model.md) |

**Unchanged. D-09's £0 stands, with ~19x headroom.**

Two caveats found while checking, neither of which changes the number:

- **The Price List API does not encode the Essentials free tier, at all.** The usage type `EUW2-CognitoEssentialsMAU` is a single `0 – Inf` band at $0.015, whereas the Lite entry's bands are offset by its 10,000 free MAU (`0 – 90,000`, i.e. 10,000–100,000 real). So the API alone would read as "no free tier". The allowance is documented on the pricing page, and that is what this table cites — do not re-derive it from the API and conclude the model is wrong.
- **The allowance is per account *or per organization*.** `ndn-prod` (357601815388) is a member of `o-tsnehqxpmj`, mastered by 803129122420, so the 10,000 is potentially shared. Checked 2026-08-22: the management account has **no Cognito user pools in `eu-west-2`, `eu-west-1` or `us-east-1`**, so the whole allowance is ours today. Worth re-checking at G2 only if something else in the organization starts using Cognito.

```bash
aws --profile ndn-prod pricing get-products --region us-east-1 --service-code AmazonCognito \
  --filters "Type=TERM_MATCH,Field=regionCode,Value=eu-west-2" --max-results 40
# EUW2-CognitoEssentialsMAU | Cognito Essentials eu-west-2 tier 1 pricing -> {'USD': '0.0150000000'} 0 - Inf
```

## Why two pools

Cognito's MFA policy is **pool-wide**. `REQUIRED` would stack a second factor on top of a patient's passwordless email OTP; `OPTIONAL` cannot compel a clinician to enrol. D-09 asks for both, so one pool cannot hold it. The full decision, what it costs and what was rejected is in [ADR-0004's Gate G1 amendment](../adr/0004-auth.md); this runbook is what was built and how to operate it.

## What was built

- **`infra/src/auth-stack.ts`** (new) — `NdnAuthStack`, `eu-west-2`: two pools, two app clients, six CloudFormation outputs.
- **`infra/bin/app.ts`** — the stack, production only. No ephemeral per-PR copy: these are `RETAIN` plus deletion protection, so a per-PR directory would be one nothing could clean up.
- **`infra/src/config.ts`** — the two pool names and the two redirect URLs.
- **`infra/src/guardrails.ts`** — `denyDirectoryDestructiveActionsStatement`, the identity-layer extension of TASK 0.3.2's pattern, plus the checked-in copy of the policy applied to `ndn-deploy`.
- **`.github/workflows/ci.yml`** — one more `oidc-dry-run` step, simulating the real deploy role against the real IAM engine.

## The two pools, side by side

| | `ndn-patients` | `ndn-clinicians` |
|---|---|---|
| Self sign-up | **On** — 2.2.3 registers, approval is a state on the DynamoDB record | **Off at the directory level** — 2.4.1's principal creates every clinician |
| First factor | Email OTP (choice-based, `ALLOW_USER_AUTH`) | Password over SRP (`ALLOW_USER_SRP_AUTH`) |
| MFA | `OFF` | `ON`, `SOFTWARE_TOKEN_MFA` only |
| SMS | Nowhere — not as a factor, not as a channel; no SNS role is synthesized | same |
| Password policy | none configured (nothing sets one) | 8 chars, upper + lower + digit + symbol |
| Recovery | Verified email only | Verified email only |
| Attributes | `email` (required, mutable). Nothing else. | same |
| Tier | Essentials | Essentials |
| Threat protection | Not enabled (paid tier) | Not enabled (paid tier) |
| Deletion | `DeletionProtection: ACTIVE` + `RemovalPolicy.RETAIN` | same |

## Two things this task could not do literally, stated plainly

The execution plan's steps say "no password" for patients and "PKCE required" for both clients. Cognito supports neither as written, so here is what was actually built and why it still holds.

**1. `AllowedFirstAuthFactors` must contain `PASSWORD`.** AWS's own console wording is "The **Password** option is always available", and CDK refuses `password: false` outright (`The password authentication cannot be disabled.`). So the patient pool's policy is `["PASSWORD", "EMAIL_OTP"]` — it cannot be `["EMAIL_OTP"]`.

What makes "no password" true anyway is the app client, which is the only way in: `ndn-patients-web` holds `ALLOW_USER_AUTH` and `ALLOW_REFRESH_TOKEN_AUTH` and nothing else. `ALLOW_USER_PASSWORD_AUTH`, `ALLOW_ADMIN_USER_PASSWORD_AUTH`, `ALLOW_USER_SRP_AUTH` and `ALLOW_CUSTOM_AUTH` are all absent, and a patient account never has a password set in the first place. The pool policy is a list of what the pool *could* offer; the client is what any caller can actually reach.

**2. Cognito has no "require PKCE" switch.** There is no user-pool or app-client setting that rejects a code exchange lacking a `code_verifier`. What exists is the public-client property: `GenerateSecret: false`, so the token exchange is unauthenticated and PKCE is the only thing binding an authorization code to whoever started the flow. **TASK 2.2.4's own code is what must send `code_challenge`** — this task's tests assert the client holds no secret and offers only the authorization code grant, which is the whole of what is enforceable here. Anyone reading "PKCE required" in the plan and expecting a server-side check should read this paragraph instead.

## The deploy role cannot delete a directory

TASK 0.3.2's guard applied to buckets and tables; this extends the same shape to the directory. `ndn-deploy` — CI's OIDC role, `PowerUserAccess` — now carries an inline `Deny`:

```bash
aws --profile ndn-prod iam put-role-policy --role-name ndn-deploy \
  --policy-name DenyDirectoryDestructivePrimitives \
  --policy-document file://infra/src/__fixtures__/guardrails/deploy-role-directory-policy.json
```

**Applied by hand, and it has to be.** `PowerUserAccess` excludes IAM management, so the role cannot attach a policy to itself and no `cdk deploy` could ever create this — the same one-time-admin path TASK 0.1.1 used for the role itself and 0.3.2 used for `ndn-break-glass`. The document is generated by `infra/scripts/print-deploy-role-directory-policy.ts` from `guardrails.ts`, checked in, and `guardrails.test.ts` fails CI if the two ever drift.

Proven against the real IAM evaluation engine, 2026-08-22:

```text
$ aws --profile ndn-prod iam simulate-principal-policy \
    --policy-source-arn arn:aws:iam::357601815388:role/ndn-deploy \
    --action-names cognito-idp:DeleteUserPool cognito-idp:DeleteUserPoolClient \
                   cognito-idp:AdminDeleteUser cognito-idp:CreateUserPool \
                   cognito-idp:CreateUserPoolClient cognito-idp:UpdateUserPool \
                   cognito-idp:DescribeUserPool cognito-idp:AdminCreateUser \
                   cognito-idp:AdminDisableUser \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text

cognito-idp:DeleteUserPool         explicitDeny
cognito-idp:DeleteUserPoolClient   explicitDeny
cognito-idp:AdminDeleteUser        explicitDeny
cognito-idp:CreateUserPool         allowed
cognito-idp:CreateUserPoolClient   allowed
cognito-idp:UpdateUserPool         allowed
cognito-idp:DescribeUserPool       allowed
cognito-idp:AdminCreateUser        allowed
cognito-idp:AdminDisableUser       allowed
```

The `allowed` half matters as much as the `explicitDeny` half: a guard that also blocked `CreateUserPool` would break the deploy it exists to outlive. CI's `oidc-dry-run` job re-runs exactly this on every PR.

**`Resource: "*"`, not a pool ARN, on purpose.** The data guard protects *named* stores while leaving the role free to act on others; there is no user pool anywhere, in any region, this role should ever be able to delete — and a resource-scoped Deny would need rewriting each time a pool is added, which is the moment it would be forgotten.

**The price of that, stated rather than discovered.** A CloudFormation update that *replaces* an app client (rather than updating it in place) will fail at its cleanup step, because the cleanup is a `DeleteUserPoolClient`. Recovery is the break-glass procedure in [iam-deny-guardrails.md](iam-deny-guardrails.md) — or, more simply, detaching this one inline policy for the duration of that deploy and re-attaching it after. That is the guard working: a change that deletes an app client invalidates every live session, and it should require a human.

`ndn-deploy-pr` is deliberately not given the same policy — no ephemeral stack creates a pool, so there is nothing there to protect.

## Owner actions, after the first deploy

The stack deploys on merge to `main` (CI's `deploy` job, `cdk deploy --all`). Two things follow, in order.

**1. Confirm the pools are what the template said.**

```bash
for pool in ndn-patients ndn-clinicians; do
  id=$(aws --profile ndn-prod cognito-idp list-user-pools --max-results 20 --region eu-west-2 \
        --query "UserPools[?Name=='$pool'].Id | [0]" --output text)
  aws --profile ndn-prod cognito-idp describe-user-pool --user-pool-id "$id" --region eu-west-2 \
    --query 'UserPool.{Name:Name,Tier:UserPoolTier,Mfa:MfaConfiguration,Mfas:EnabledMfas,
             SelfSignUp:AdminCreateUserConfig.AllowAdminCreateUserOnly,
             Deletion:DeletionProtection,SignIn:Policies.SignInPolicy}'
done
```

Expect: patients → `MfaConfiguration: OFF`, `AllowAdminCreateUserOnly: false`, `AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]`; clinicians → `ON` with `[SOFTWARE_TOKEN_MFA]`, `AllowAdminCreateUserOnly: true`, no `SignInPolicy`; both `ESSENTIALS` and `ACTIVE`.

**2. Record the four identifiers in `infra/src/config.ts`.** Cognito generates pool and client ids, so they cannot be constants before the first deploy — this is the one part of step 8 that is necessarily post-deploy, and it is also TASK 2.2.2's first move (its authorizer verifies `iss` and `aud` against exactly these).

```bash
aws --profile ndn-prod cloudformation describe-stacks --stack-name NdnAuthStack --region eu-west-2 \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
```

They are identifiers, not secrets — the same standing `CERTIFICATE_ARN` has. Nothing reads them until 2.2.2, so the gap between deploy and recording is inert.

## Email delivery is the open constraint, and 2.2.3 owns it

Both pools use **Cognito's default email sender**, not SES. Two facts follow, and neither is a defect in this task:

- Cognito's default sender is capped at **50 emails/day per account**. A patient signs in with an email OTP *every time*, so at any real patient volume that cap binds.
- Switching to SES today would be **worse**, not better: SES production access for this account was **denied** on 2026-08-21 ([ses-production-access.md](ses-production-access.md)), so sandbox rules apply and mail can only reach verified identities — i.e. no real patient could receive an OTP at all.

So the correct order is: SES production access first, then point both pools at the existing verified `nourishthenerve.com` identity and the `ndn-email` configuration set (which already carries bounce/complaint alarms). **TASK 2.2.3 must not go live to real patients until one of those two is true.**

## Cost

**£0.00.** Two user pools, two app clients, one inline IAM policy statement, no Lambdas, no log groups, no alarms. Cognito is billed per monthly active user and both directories are empty; 509 modelled MAU sits inside a 10,000 always-free allowance either way. `03-cost-model.md`'s Cognito line is unchanged and now carries the 2026-08-22 re-verification date.

## Verification

- `pnpm -r lint && pnpm -r typecheck && pnpm test` — green; `infra` goes from 129 tests across 7 files to **161 across 8** — 27 new in `auth-stack.test.ts`, 5 new in `guardrails.test.ts`.
- `pnpm --filter @ndn/infra run synth` — `NdnAuthStack` synthesizes.
- The policy simulator output above, against the real `ndn-deploy` role.
- Post-deploy: the two `describe-user-pool` commands under "Owner actions".

## Rollback

- **Before any real user exists:** `cdk destroy NdnAuthStack`. Note what that does and does not do — `RemovalPolicy.RETAIN` means CloudFormation *orphans* the pools rather than deleting them, and `DeletionProtection: ACTIVE` plus the new Deny means neither CDK nor the deploy role could delete them if it tried. The stack goes; the directories stay.
- **After a real user exists: forward only.** That is what RETAIN and deletion protection are for. A pool that a bad deploy can take with it is not a directory you can put patients in.
- **The `ndn-deploy` inline policy** (real, applied by hand, not part of the branch): `aws --profile ndn-prod iam delete-role-policy --role-name ndn-deploy --policy-name DenyDirectoryDestructivePrimitives`. Leaves `PowerUserAccess` untouched. Reverting the branch without this leaves a harmless orphan policy on a role with no pools to protect.

## Not done in this task, deliberately

- **No user pool domain / managed login.** The app clients carry OAuth callback and logout URLs, but no hosted-UI domain exists, so the `/oauth2/*` endpoints are unreachable. That is TASK 2.2.4's call to make: its own steps describe a React island with its own OTP input (SDK-based, choice-based auth), which needs no domain at all — and standing up a hosted UI this task cannot exercise would be guessing at 2.2.4's design. Until then the OAuth block is configuration, not a live surface.
- **No SES email configuration** — see "Email delivery" above.
- **No `cognito:groups` membership.** `principal-clinician` versus `sub-clinician` is 2.2.2's read of the group claim and 2.4.1's write of it; the pools ship with no groups.
- **No Lambda triggers.** The Post-Confirmation trigger that creates a `PAT#`/`PROFILE` row is TASK 2.2.3.
- **No authorizer.** TASK 2.2.2. Until it exists, these pools are inert — which is why this task carries no feature flag.
