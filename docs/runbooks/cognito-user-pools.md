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

## Amendment, D-29 (2026-08-29) — the patient pool reverts to a password

The owner's own decision: a patient never registers or authenticates themselves via a self-serve email-OTP flow at all. They contact the clinic's WhatsApp Business number; a human verifies who they are and creates the account on their behalf, setting a permanent password the patient does not choose. **Full detail:** [patient-account-provisioning.md](patient-account-provisioning.md) (the new runbook this task built) and `infra/src/auth-stack.ts`'s own header amendment (the exact CDK-level reasoning, including why `AccountRecovery.NONE` is the one setting this change could not skip).

What actually changed on `ndn-patients`, in brief: `selfSignUpEnabled: false` (matches the clinician pool now); an **explicit** `signInPolicy` restricting `AllowedFirstAuthFactors` to `[PASSWORD]` — found live on this amendment's first deploy that simply *removing* the field from CDK does not clear a pool's previously-set `SignInPolicy` (`UpdateUserPool` leaves it stale on omission; only an explicit narrower value actually applies — see `infra/src/auth-stack.ts`'s own comment on the patient pool construction); a `passwordPolicy` identical to the clinician pool's; `accountRecovery: AccountRecovery.NONE` (`ForgotPassword` is unauthenticated and pool-recovery-setting-gated, not app-client-flow-gated — leaving `EMAIL_ONLY` would have been a real hole in the WhatsApp-verified model); the web client's `authFlows` move from `{ user: true }` to `{ userSrp: true }`; the Post-Confirmation trigger is deleted outright (no `ConfirmSignUp` event can fire with self sign-up off).

**Everything below this point that describes the patient pool's first factor as email OTP, its self sign-up as on, or its recovery as email-based is TASK 2.2.1's original, 2026-08-22 design — kept as the historical record of what was actually deployed and verified that day, not updated in place.** The "two pools, side by side" table immediately below is the one exception: its patient column is corrected to current state, with this note as the pointer to why.

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
| Self sign-up | **Off at the directory level** (D-29) — `patient-admin.ts`'s principal creates every account | **Off at the directory level** — 2.4.1's principal creates every clinician |
| First factor | Password over SRP (`ALLOW_USER_SRP_AUTH`) (D-29) | Password over SRP (`ALLOW_USER_SRP_AUTH`) |
| MFA | `OFF` | `ON`, `SOFTWARE_TOKEN_MFA` only |
| SMS | Nowhere — not as a factor, not as a channel; no SNS role is synthesized | same |
| Password policy | 8 chars, upper + lower + digit + symbol (D-29) — every password machine-generated | 8 chars, upper + lower + digit + symbol |
| Recovery | Admin only — no self-service reset (D-29) | Verified email only |
| Attributes | `email`, required and mutable — the only one configured, the only one required, and the only one either client can write. Cognito's 21 unremovable standard attributes are still present but unreachable; see "One imprecision" below | same |
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

## The first deploy, and what it actually reported

**The patient-pool findings below (email OTP, `AllowAdminCreateUserOnly: false`, `[PASSWORD, EMAIL_OTP]`) describe 2026-08-22's deploy and are superseded for the patient pool by D-29 (2026-08-29) — see the amendment above.** Kept verbatim as the historical record of that day's real, verified state; the clinician-pool findings are unaffected by D-29 and remain current.

Deployed by CI on the merge of PR #56, **2026-08-22**. Everything below is the deployed state, not the template's intent — three things came back differently from what `describe-user-pool` alone suggests, and all three are recorded rather than smoothed over.

**The identifiers, now in `infra/src/config.ts`** (step 8's necessarily post-deploy half — Cognito generates these, CDK cannot name them):

| | Pool id | App client id |
|---|---|---|
| `ndn-patients` | `eu-west-2_lMonWXA0b` | `6r45vfhjv9atkq3iojfinr3lda` |
| `ndn-clinicians` | `eu-west-2_1SFN2y0Jt` | `2dt02jv4lstdvh9fl4cnsqn4gn` |

Read from the stack's own outputs, never the console:

```bash
aws --profile ndn-prod cloudformation describe-stacks --stack-name NdnAuthStack --region eu-west-2 \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' --output text
```

`config.ts` **derives** the two issuer URLs from the pool ids rather than pasting them a second time, and `auth-stack.test.ts` asserts the derived pair equals what this deploy reported — so a mistyped pool id fails in `pnpm test` rather than at 2.2.2's first token verification, where it would present as every sign-in failing on a signature error.

### Verifying the pools — use `get-user-pool-mfa-config`, not `describe-user-pool`

`describe-user-pool` **does not populate `EnabledMfas`**. It returns `null` there even on a pool with TOTP correctly enabled, which reads alarmingly like "MFA is on but no factor is configured". The authoritative call is `get-user-pool-mfa-config`:

```bash
for pool in ndn-patients ndn-clinicians; do
  id=$(aws --profile ndn-prod cognito-idp list-user-pools --max-results 20 --region eu-west-2 \
        --query "UserPools[?Name=='$pool'].Id | [0]" --output text)
  aws --profile ndn-prod cognito-idp get-user-pool-mfa-config --user-pool-id "$id" --region eu-west-2
  aws --profile ndn-prod cognito-idp describe-user-pool --user-pool-id "$id" --region eu-west-2 \
    --query 'UserPool.{Name:Name,Tier:UserPoolTier,AdminOnly:AdminCreateUserConfig.AllowAdminCreateUserOnly,
             Deletion:DeletionProtection,SignIn:Policies.SignInPolicy,Addons:UserPoolAddOns}'
done
```

What it returned, 2026-08-22:

```text
ndn-patients    { "MfaConfiguration": "OFF" }
ndn-clinicians  { "MfaConfiguration": "ON",
                  "SoftwareTokenMfaConfiguration": { "Enabled": true },
                  "WebAuthnConfiguration": { "FactorConfiguration": "SINGLE_FACTOR" } }
```

**No `SmsMfaConfiguration` on either.** TOTP is the clinician pool's only second factor, exactly as designed, and the absence is what proves it rather than a setting saying so.

Both pools: `ESSENTIALS`, `DeletionProtection: ACTIVE`, no `UserPoolAddOns` (threat protection off). Patients `AllowAdminCreateUserOnly: false` with `AllowedFirstAuthFactors: [PASSWORD, EMAIL_OTP]`; clinicians `true`, and Cognito filled the unset policy in as `[PASSWORD]` explicitly — the default this task wanted, now visible rather than implied.

Both clients came back with `ClientSecret: null`, `ExplicitAuthFlows` exactly as synthesized (`ALLOW_USER_AUTH` / `ALLOW_USER_SRP_AUTH`, each plus refresh), `code` as the only OAuth flow, both redirect URLs on the apex, `ReadAttributes [email, email_verified]`, `WriteAttributes [email]`, revocation on, 60-minute tokens on a 43200-minute refresh.

### `WebAuthnConfiguration` appears on the clinician pool by default. It is inert — and here is what would change that

Cognito set `WebAuthnConfiguration: { FactorConfiguration: SINGLE_FACTOR }` on `ndn-clinicians` without being asked. Read plainly, "single factor" means a passkey alone could sign someone in — which would be a TOTP bypass on the one pool that must not have one.

It cannot happen today, for two independent reasons:

1. `AllowedFirstAuthFactors` on that pool is `[PASSWORD]`. `WEB_AUTHN` is not in the list, so Cognito will not offer it.
2. `WEB_AUTHN` is only reachable through choice-based authentication (`ALLOW_USER_AUTH`), and the clinician app client holds `ALLOW_USER_SRP_AUTH` instead.

**Either one of those changing turns a dormant default into a live bypass.** If a future task adds `ALLOW_USER_AUTH` to `ndn-clinicians-web` — for a nicer sign-in UI, say — it must also set that pool's `webAuthnUserVerification` deliberately or keep `WEB_AUTHN` out of the first-factor list. Written here because nothing in the template mentions WebAuthn at all, so nothing would remind anyone.

### One imprecision in this runbook's own table, corrected

The "Attributes" row below reads `email` and nothing else. That is true of what **CDK configures** and of what the **app clients can touch**, and it is *not* true of `SchemaAttributes` in the deployed pool: every Cognito user pool carries all 21 standard OIDC attributes (`name`, `birthdate`, `address`, `phone_number`, …) whether you ask for them or not. They cannot be removed.

So the real guarantee is not "the schema has one attribute" — it is that `email` is the only one marked `Required`, no custom attribute exists, and **both app clients can read only `email`/`email_verified` and write only `email`**. A handler cannot put a patient's name or phone number into the directory because the client it goes through cannot write those fields. That is the assertion `auth-stack.test.ts` makes, and it is the one that holds.

## Email delivery — moot for patients since D-29, still real for anything else Cognito emails

This section described a real, binding constraint on TASK 2.2.3's email-OTP design: Cognito's default sender is capped at 50 emails/day, a patient signed in with an OTP *every time*, and SES production access was denied, so no real patient could ever have received one. **D-29 removes the constraint by removing the flow it constrained** — a patient's Cognito account is created with `MessageAction: SUPPRESS` (`patient-admin-handler.ts`) and never emailed or texted anything; the password reaches the patient over WhatsApp, not through Cognito. Neither pool sends a patient any message at all any more.

The clinician pool is unaffected: `AdminCreateUser`'s own invite email (`clinician-admin.ts`) still goes through Cognito's default sender, and the same 50/day cap and SES-sandbox constraint still apply to it, at clinician volume rather than patient volume.

## Cost

**£0.00.** Two user pools, two app clients, one inline IAM policy statement, no Lambdas, no log groups, no alarms. Cognito is billed per monthly active user and both directories are empty; 509 modelled MAU sits inside a 10,000 always-free allowance either way. `03-cost-model.md`'s Cognito line is unchanged and now carries the 2026-08-22 re-verification date.

## Verification

- `pnpm -r lint && pnpm -r typecheck && pnpm test` — green; `infra` goes from 129 tests across 7 files to **164 across 8** — 30 new in `auth-stack.test.ts` (27 on the synthesized template, 3 on the recorded identifiers), 5 new in `guardrails.test.ts`.
- `pnpm --filter @ndn/infra run synth` — `NdnAuthStack` synthesizes.
- The policy simulator output above, against the real `ndn-deploy` role.
- Post-deploy, 2026-08-22: the `get-user-pool-mfa-config` and `describe-user-pool` output recorded under "The first deploy" — including the three things that differ from what the template alone implies.

## Rollback

- **Before any real user exists:** `cdk destroy NdnAuthStack`. Note what that does and does not do — `RemovalPolicy.RETAIN` means CloudFormation *orphans* the pools rather than deleting them, and `DeletionProtection: ACTIVE` plus the new Deny means neither CDK nor the deploy role could delete them if it tried. The stack goes; the directories stay.
- **After a real user exists: forward only.** That is what RETAIN and deletion protection are for. A pool that a bad deploy can take with it is not a directory you can put patients in.
- **The `ndn-deploy` inline policy** (real, applied by hand, not part of the branch): `aws --profile ndn-prod iam delete-role-policy --role-name ndn-deploy --policy-name DenyDirectoryDestructivePrimitives`. Leaves `PowerUserAccess` untouched. Reverting the branch without this leaves a harmless orphan policy on a role with no pools to protect.

## Not done in this task, deliberately

- **No user pool domain / managed login.** The app clients carry OAuth callback and logout URLs, but no hosted-UI domain exists, so the `/oauth2/*` endpoints are unreachable. That is TASK 2.2.4's call to make: its own steps describe a React island with its own OTP input (SDK-based, choice-based auth), which needs no domain at all — and standing up a hosted UI this task cannot exercise would be guessing at 2.2.4's design. Until then the OAuth block is configuration, not a live surface.
- **No SES email configuration** — see "Email delivery" above.
- **No `cognito:groups` membership.** `principal-clinician` versus `sub-clinician` is 2.2.2's read of the group claim and 2.4.1's write of it; the pools ship with no groups.
- **No Lambda triggers.** TASK 2.2.3 later added the Post-Confirmation trigger that created a `PAT#`/`PROFILE` row on sign-up confirmation; D-29 (2026-08-29) deleted it — self sign-up is off, so no `ConfirmSignUp` event exists for a trigger to react to any more. Neither pool carries a Lambda trigger of any kind today.
- **No authorizer.** TASK 2.2.2. Until it exists, these pools are inert — which is why this task carries no feature flag.
