# IAM deny guardrails (TASK 0.3.2)

**Date:** 2026-08-09 · **Task:** [05-execution-plan.md § TASK 0.3.2](../plan/05-execution-plan.md) · **Requirements:** §6.7, NFR-03 · **Depends on:** 0.1.1, 0.3.1

## What this covers

The IAM-layer half of the two-layer data-protection guard (00-conventions.md's prohibition). The code-layer half (`ndn/no-destructive-primitives`) is TASK 0.3.1 and lands first specifically so this task's Deny statements can be authored at all — the rule's allowlist only permits an `s3:DeleteObject*` action string inside an `infra/` file, inside an object literal carrying `effect`/`Effect: Deny`. Every statement in `infra/src/guardrails.ts` uses exactly that shape (`new iam.PolicyStatement({ effect: Effect.DENY, actions: [...] })`), so the two tasks' guards compose rather than fight each other.

No runtime role, bucket, or DynamoDB table is deployed yet — TASK 0.4.1 is the first task that deploys real application infrastructure. This task delivers the reusable guardrail mechanism plus real, independently-verified proof that it works, ready for 0.4.1 onward to attach to whatever it deploys.

## What was done

### 1–2. Runtime role Deny + S3 bucket policy Deny (`infra/src/guardrails.ts`)

- `denyDestructiveActionsStatement(resources)` — an identity-based `Deny` on `s3:DeleteObject`, `s3:DeleteObjectVersion`, `dynamodb:DeleteItem`, `dynamodb:DeleteTable`, scoped to the given buckets'/tables' ARNs. Explicit `Deny` always outranks any `Allow` elsewhere in AWS's policy evaluation, including a future accidental broad grant to the same role.
- `denyBucketDeleteToPrincipalStatement(bucket, principal)` — the matching resource-based `Deny` on an S3 bucket policy, naming the runtime role as principal. Defence in depth: the guard survives even if the role's own identity-based policy is ever misconfigured, because two independent evaluation paths (identity-based and resource-based) would both have to fail open at once.
- `attachDestructiveActionGuardrail(role, resources)` — attaches both to a real role/buckets in one call. **Not invoked against any real resource in this task** — there isn't one yet. TASK 0.4.1+ calls this once its runtime role and buckets exist.

### 3. Break-glass role — both a CDK construct and a real, deployed role

- `BreakGlassRole` (CDK construct, `infra/src/guardrails.ts`) — trust policy requires `aws:MultiFactorAuthPresent: true`, assumable by any principal in the account (`AccountPrincipal`). **No `addToPolicy` call anywhere in this file grants it anything** — it carries zero permissions by construction.
- The real role was created directly via the AWS CLI in `ndn-prod` — the same mechanism TASK 0.1.1 used for `ndn-deploy`/`ndn-admin`/`ndn-ci-readonly` (no CDK bootstrap exists in `ndn-prod` yet; that lands with TASK 0.4.1's first real stack, and IAM-only setup in this account has consistently been done via direct CLI ahead of it). The role's trust policy was written to match exactly what `BreakGlassRole`'s CDK construct synthesizes (`{"AWS": "arn:aws:iam::357601815388:root"}` is CDK's own `AccountPrincipal` output — an account-root principal ARN in a trust policy means "any IAM principal in that account", not literally the root user), so a future CDK-managed import of this role (`iam.Role.fromRoleName`, or a `cdk import`) will find no drift.

  ```text
  $ aws --profile ndn-prod iam create-role --role-name ndn-break-glass \
      --assume-role-policy-document file://break-glass-trust-policy.json ...
  ndn-break-glass   arn:aws:iam::357601815388:role/ndn-break-glass
  ```

**Why the break-glass role's *permissions* are deliberately never code, anywhere, ever.** TASK 0.3.2's DoD says "do not implement any break-glass deletion code path." Writing the role's eventual delete permissions as `{ effect: Effect.ALLOW, actions: ['s3:DeleteObject', ...] }` in `infra/` would itself be perfectly legal syntax — `ndn/no-destructive-primitives`' allowlist only blocks `s3:DeleteObject*` strings *without* an enclosing `Deny`, an `Allow` isn't a syntax-level violation of that specific rule. The real backstop is procedural, not syntactic: the permission grant happens only as a manual, out-of-band, un-committed AWS Console/CLI action by a human who has already assumed this role with MFA, at the moment it's genuinely needed, and is removed again afterward. Nothing in this repository can perform, trigger, or automate that step. See "Manual procedure" below.

### Manual procedure (for the human who ends up needing this)

1. Sign in as `ndn-admin` (`https://357601815388.signin.aws.amazon.com/console`) with MFA, or `aws --profile ndn-prod sts assume-role --role-arn arn:aws:iam::357601815388:role/ndn-break-glass --role-session-name break-glass --serial-number <your MFA device ARN> --token-code <current code>` from the CLI.
2. Attach a **narrowly scoped, temporary** inline policy to `ndn-break-glass` granting only the specific action/resource actually needed (e.g. `dynamodb:DeleteItem` on one specific item, not a wildcard).
3. Perform the action.
4. **Detach the inline policy immediately afterward** (`aws iam delete-role-policy --role-name ndn-break-glass --policy-name <name>`) — the role must return to zero permissions. Confirm with `aws iam list-role-policies --role-name ndn-break-glass` (expect an empty list).
5. Record what was deleted, why, and by whom — CloudTrail already logs the `AssumeRole` and the policy attach/detach calls (TASK 0.1.1's trail), but a human-readable note belongs wherever this project tracks incidents.

## Verification

### Local proof against the real IAM engine (this task)

`infra/src/guardrails.ts` exports `buildExampleRuntimePolicyDocument()`, which combines the real `denyDestructiveActionsStatement()` output with an illustrative baseline `Allow` (the ordinary read/write permissions a real runtime role would carry) against illustrative example ARNs (`arn:aws:s3:::ndn-example-media`, `arn:aws:dynamodb:eu-west-2:357601815388:table/ndn-example-data` — no such bucket/table exists; `simulate-custom-policy` explicitly supports simulating against resources that don't exist in the account). `infra/scripts/print-example-guardrail-policy.ts` is a thin wrapper that prints it, and its output is checked in at `infra/src/__fixtures__/guardrails/example-runtime-policy.json`.

```bash
$ npx tsx infra/scripts/print-example-guardrail-policy.ts > /tmp/policy.json
$ jq -c '[tojson]' /tmp/policy.json > /tmp/policy-input-list.json
$ aws --profile ndn-prod iam simulate-custom-policy \
    --policy-input-list file:///tmp/policy-input-list.json \
    --action-names s3:DeleteObject s3:DeleteObjectVersion s3:PutObject s3:GetObject \
                    dynamodb:DeleteItem dynamodb:DeleteTable dynamodb:PutItem dynamodb:GetItem \
    --resource-arns arn:aws:s3:::ndn-example-media/foo.jpg \
                     arn:aws:dynamodb:eu-west-2:357601815388:table/ndn-example-data \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text

s3:DeleteObject          explicitDeny
s3:DeleteObjectVersion   explicitDeny
s3:PutObject             allowed
s3:GetObject             allowed
dynamodb:DeleteItem      explicitDeny
dynamodb:DeleteTable     explicitDeny
dynamodb:PutItem         allowed
dynamodb:GetItem         allowed
```

This is the real AWS IAM policy evaluation engine, not a mock or an approximation of it — the same engine that will evaluate the real policy once TASK 0.4.1 attaches `attachDestructiveActionGuardrail` to an actual role. `s3:DeleteObject`/`s3:DeleteObjectVersion`/`dynamodb:DeleteItem`/`dynamodb:DeleteTable` → `explicitDeny`; ordinary reads/writes → `allowed`. Matches TASK 0.3.2's Tests line exactly ("runtime role DeleteObject → AccessDenied; PutObject to a media prefix → succeeds").

### The break-glass role, for real, in `ndn-prod`

```bash
$ aws --profile ndn-prod iam list-attached-role-policies --role-name ndn-break-glass
{ "AttachedPolicies": [] }
$ aws --profile ndn-prod iam list-role-policies --role-name ndn-break-glass
{ "PolicyNames": [] }
$ aws --profile ndn-prod iam simulate-principal-policy \
    --policy-source-arn arn:aws:iam::357601815388:role/ndn-break-glass \
    --action-names s3:DeleteObject dynamodb:DeleteItem s3:GetObject \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
s3:DeleteObject      implicitDeny
dynamodb:DeleteItem  implicitDeny
s3:GetObject         implicitDeny
```

Zero attached policies (managed or inline); every action, including ordinary reads, is `implicitDeny` — the role is genuinely unused and grants nothing today, exactly as designed.

### Automated: CDK-assertion tests (`infra/src/guardrails.test.ts`, runs in `pnpm test`/CI on every PR)

CDK's `aws-cdk-lib/assertions` synthesizes the exact CloudFormation template AWS would receive from a real deploy, with zero live AWS calls — "integration against emulated AWS" from the Tests line. Covers: the runtime-role policy carries the `Deny` with all four actions and nothing broader (a negative test walks every `Deny` statement in the synthesized template and asserts none of it names an ordinary read/write action); the bucket policy carries the matching `Deny` naming the role as principal; `BreakGlassRole`'s trust policy requires MFA; `BreakGlassRole` has zero `AWS::IAM::Policy`/`AWS::IAM::ManagedPolicy` resources attached (`template.resourceCountIs(..., 0)`).

Two more tests guard the CI proof's own integrity: `buildExampleRuntimePolicyDocument()`'s output must equal the checked-in fixture (a stale fixture would let the CI step below quietly stop meaning anything) and the Deny statement must outrank the baseline Allow for all four actions.

### Automated: real IAM simulator in CI (`.github/workflows/ci.yml`, `oidc-dry-run` job, every PR)

Extends the `oidc-dry-run` job TASK 0.2.1 built (see [ci-pipeline.md](ci-pipeline.md)) with a second step. `ndn-ci-readonly` was granted one additional permission — `iam:SimulateCustomPolicy`, resource `"*"` (this action evaluates an arbitrary policy document supplied in the call; there is no existing entity to scope it down to, and it performs no action against any real resource — read-only, zero blast radius, consistent with the role's existing minimal design):

```bash
$ aws --profile ndn-prod iam put-role-policy --role-name ndn-ci-readonly \
    --policy-name SimulateGuardrailPolicies --policy-document file://simulate-guardrail-policies.json
$ aws --profile ndn-prod iam simulate-principal-policy \
    --policy-source-arn arn:aws:iam::357601815388:role/ndn-ci-readonly \
    --action-names iam:SimulateCustomPolicy iam:CreateUser \
    --query 'EvaluationResults[].[EvalActionName,EvalDecision]' --output text
iam:SimulateCustomPolicy   allowed
iam:CreateUser             implicitDeny
```

The new step reads `infra/src/__fixtures__/guardrails/example-runtime-policy.json` (via `actions/checkout`, added to this job for the first time — its `permissions:` block needed `contents: read` restated alongside `id-token: write`, since job-level `permissions` replace rather than merge with the workflow-level block, the same gotcha this file's own comments already document for the `changes` job) and runs the identical `simulate-custom-policy` call shown above, asserting `explicitDeny`/`allowed` via `grep`. Runs on `pull_request` only, same trust-condition reason `oidc-dry-run`'s other step does; included in `ci-summary`'s required gate from first landing (unlike `oidc-dry-run`'s original step, this reuses an already-proven-working OIDC path, so there's no equivalent "watch the first real run" caution needed).

## Cost delta

£0.00 — one IAM role (`ndn-break-glass`, no permissions attached) and one additional inline-policy statement on an existing role (`ndn-ci-readonly`). Both are free. `simulate-custom-policy` and `simulate-principal-policy` are free, read-only IAM API calls, same as TASK 0.1.1/0.2.1's existing use of the policy simulator. No S3, DynamoDB, or CDK-deployed resources were created.

## Not done in this task (explicitly out of scope, deferred)

- Actually attaching `attachDestructiveActionGuardrail` to a real runtime role and bucket — TASK 0.4.1 onward, once those exist.
- A DynamoDB resource-based policy mirroring the S3 bucket-policy defence-in-depth layer. The task's step 2 names only "S3 bucket policy" — DynamoDB resource-based policies are a separate, newer AWS feature not mentioned in TASK 0.3.2's Steps; revisit at 0.4.1 if desired.
- CDK bootstrap in `ndn-prod` — the break-glass role was created via direct CLI specifically to avoid pulling that forward; TASK 0.4.1 bootstraps CDK for real.
- Granting `ndn-break-glass` any permissions — by design; see "Manual procedure" above.

## Rollback

- `infra/src/guardrails.ts` and its tests/fixtures/script: revert the branch/PR. Nothing outside the repo depends on this code existing (it isn't invoked against any real resource yet).
- CI workflow change: revert the branch/PR. The `oidc-dry-run` job's new step only reads AWS state (no writes), same as its existing step.
- `ndn-break-glass` role (real, in `ndn-prod`, applied directly, not via this branch): `aws --profile ndn-prod iam delete-role --role-name ndn-break-glass` (safe — it has zero attached policies to detach first).
- `ndn-ci-readonly`'s new `SimulateGuardrailPolicies` inline policy (real, applied directly): `aws --profile ndn-prod iam delete-role-policy --role-name ndn-ci-readonly --policy-name SimulateGuardrailPolicies`. Leaves `SimulateNdnDeployOnly` (TASK 0.2.1) untouched.
