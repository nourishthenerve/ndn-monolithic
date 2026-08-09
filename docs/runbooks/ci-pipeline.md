# CI pipeline with quality gates (TASK 0.2.1)

**Date:** 2026-08-08 · **Task:** [05-execution-plan.md § TASK 0.2.1](../plan/05-execution-plan.md) · **Requirements:** C-06, C-09, NFR-03, NFR-06 · **Risks:** R-08, R-13

## What this covers

`.github/workflows/ci.yml` — the only gate between a commit and production, per C-06 (no staging environment exists on AWS). Six jobs:

| Job | Runs when | What it gates |
|---|---|---|
| `changes` | always | path classification (code vs. docs) feeding the two jobs below |
| `quality` | code changed | install (cached) → lint → typecheck → unit → integration → coverage thresholds → dependency audit |
| `docs-lint` | docs changed | markdownlint + offline internal-link check |
| `secret-scan` | always | gitleaks over full git history |
| `oidc-dry-run` | `pull_request` only, informational | proves `ndn-deploy` still has exactly the access TASK 0.1.1 granted it, via a separate read-only role (see [Security fix](#security-fix-tighten-ndn-deploys-oidc-trust-2026-08-09) below) |
| `ci-summary` | always | single required status check; gates on the four above (not `oidc-dry-run`, see below) and prints CI minutes used to the job summary |

## Scope consolidation: this task absorbs three stale plan references

The finalised `docs/plan/05-execution-plan.md` has exactly one task under M0.2 (0.2.1), but three other documents still reference sub-tasks that don't exist in that finalised plan — evidently collapsed during planning without the cross-references being updated:

- TASK 0.1.2's own text: coverage-threshold enforcement "not yet enforced (**0.2.3** enforces)".
- The risk register: R-13 (CI minute budget) mitigated by "**0.2.4**".
- TASK 0.0.1's Tests line: "Markdown lint + link check in CI (added by **0.2.1**...)" — this one *is* correctly numbered, and is the tell: 0.2.1's own Steps line ("coverage thresholds", "path filters ... protects the 2,000-minute budget") already matches what 0.2.3/0.2.4 would have covered. All three land here, in this one task, rather than being silently dropped.

## Design decisions

**Path filtering can't happen at the `on:` trigger level.** If docs-only PRs never triggered the workflow at all, the required status check would sit in "Expected — waiting for status to be reported" forever and block merging. Instead, the workflow always triggers; a fast `changes` job (via `dorny/paths-filter`) computes `code`/`docs` outputs, and `quality`/`docs-lint` are conditionally skipped per-job. GitHub treats a skipped required job as passing, so this still protects R-13's minute budget without breaking branch protection.

**`predicate-quantifier: some-with-excludes` is required, not optional, on the paths-filter step.** The default quantifier (`some`) evaluates each pattern in a filter's list independently and passes if *any* one matches — so a filter written as `['**', '!docs/**', '!**/*.md']` would always evaluate `code: true`, because the bare `'**'` alone already satisfies "at least one pattern matches"; the negations would be silently inert. Caught by reading the library's README directly rather than trusting an assumption — confirmed with `some-with-excludes` ("matches at least one positive pattern **and** none of the negated ones"), which is what the filter actually needs. Verified against the library's own documented example for this exact use case (a "match everything except docs/markdown" filter).

**Unit tests and coverage are two separate steps, not one.** `pnpm run test` (unit, per-package, no instrumentation) and `pnpm run test:coverage` (root `vitest run --coverage`, thresholds enforced) do re-run the same trivial suite twice today. Kept separate anyway — the task's own Steps line lists them as distinct pipeline stages, a coverage-threshold failure should be immediately distinguishable from a test failure in the Actions UI, and the duplicate run costs low tens of milliseconds at current suite size. Worth collapsing later if the suite grows enough for that duplication to matter for R-13.

**`tests/integration` gets a dedicated vitest config with `passWithNoTests: true`.** No integration tests exist yet — `tests/integration/` was scaffolded empty by TASK 0.1.2, content lands with later tasks (0.3.2 and beyond, against emulated AWS). The CI step exists now so it starts gating the moment tests land, same "configured but not yet enforced" pattern TASK 0.1.2 used for coverage.

**Secret scanning uses the gitleaks binary directly, not `gitleaks-action`.** The marketplace action requires a paid license for organisation-owned private repos (this one is under the `nourishthenerve` org); the underlying CLI is MIT-licensed with no such restriction. The workflow downloads the pinned release tarball, verifies it against gitleaks' own published `sha256` checksums file, then runs `gitleaks detect` over full git history (`fetch-depth: 0`) — tested for real against this repo during this task (0 leaks, 7 commits scanned).

**Markdown lint + link check are scoped to `docs/**` only, not the whole repo.** The root planning-brief file (`ndn-planning-brief-md-this-is-cozy-sunrise.md`) is a frozen discovery artifact — TASK 0.0.1 copied it *verbatim* into `docs/plan/*`, and editing it now to satisfy a lint rule would mean it's no longer verbatim, for no benefit (nobody edits it going forward). `.markdownlint-cli2.jsonc` disables `MD013` (line-length — spec prose and reference tables routinely exceed 80 chars by design), `MD029` (ordered-list-prefix — runbooks intentionally continue a task's step numbering across sessions rather than restarting at 1), and `MD036` (emphasis-as-heading — one deliberate parenthetical aside). Every other default rule is on. Turning the gate on meant *fixing* the real violations it found in already-merged docs (missing blank lines around headings/lists/fences/tables, two bare code fences missing a language tag, and one heading-level skip from h1 straight to h3 in `05-execution-plan.md`) rather than muting them — all whitespace/heading-depth changes, no prose content changed. Link check runs `lychee --offline`: this repo's docs link to things that don't exist yet by design (TASK 0.4.1's staging hostname) and to account-specific AWS console URLs, so checking those over the network would make the gate flaky by construction, not by bug. Offline mode still catches the actual failure mode a docs "link check" exists for: a typo'd relative path between the manifest docs.

**`oidc-dry-run` closes a loop TASK 0.1.1 explicitly deferred, but lands informational-only.** TASK 0.1.1's own Tests line calls for "assume `ndn-deploy` from a CI dry-run and confirm it can `cloudformation:DescribeStacks` and cannot `iam:CreateUser`" — its runbook (`aws-account-baseline.md`) notes this was "deferred to TASK 0.2.1, where CI first exists to run it from." That's now, but via `ndn-ci-readonly` rather than `ndn-deploy` directly — see [Security fix](#security-fix-tighten-ndn-deploys-oidc-trust-2026-08-09) below for why. It is deliberately **excluded** from `ci-summary`'s pass/fail gate on this first landing: it's the first time either trust policy is exercised from a live Actions run rather than a manual CLI call, and there's no way to dry-run GitHub Actions itself locally. Watch the first real run; once it's green, promote it into `ci-summary`'s required list (see Owner actions below). Role ARNs are inlined rather than stored as repo variables — they're already public in this repo's own committed runbooks and an ARN alone grants no access without satisfying the OIDC trust condition, so gating them behind manual repo configuration would only add friction, not safety.

## Security fix: tighten `ndn-deploy`'s OIDC trust (2026-08-09)

A follow-up security review of `main` (after `gh` CLI access was set up) found that `ndn-deploy`'s trust policy — created in TASK 0.1.1, before CI existed to exercise it — accepted the OIDC subject `repo:nourishthenerve/ndn-monolithic:pull_request`. That subject is the **fixed string** GitHub issues for any pull request against this repo; it is not scoped by author, fork, or branch. Any collaborator able to open a PR (or anyone who compromised such an account) could have added a workflow step in their own PR branch to assume `ndn-deploy` — which carries `PowerUserAccess` on account `357601815388` — from unreviewed code. Not exploitable at the time it was found (this is a private repo with one collaborator), but `aws-account-baseline.md` already anticipates a future hire getting repo access, at which point this would have been live.

**Fix applied**, live on AWS account `357601815388`:

1. `ndn-deploy`'s trust policy `StringLike` condition was reduced to `repo:nourishthenerve/ndn-monolithic:ref:refs/heads/main` only — the `pull_request` clause was removed. `PowerUserAccess` (the permissions side) is unchanged.
2. A new role, **`ndn-ci-readonly`** (`arn:aws:iam::357601815388:role/ndn-ci-readonly`), was created with the trust policy `ndn-deploy` used to have for `pull_request` — but with exactly one inline permission: `iam:SimulatePrincipalPolicy`, resource-scoped to `ndn-deploy`'s ARN only. This lets a PR-time CI run prove what `ndn-deploy` *would* be allowed to do, without that run ever being able to hold `ndn-deploy`'s actual `PowerUserAccess` credentials.
3. `.github/workflows/ci.yml`'s `oidc-dry-run` job now assumes `ndn-ci-readonly`, and is restricted to `if: github.event_name == 'pull_request'` — `ndn-ci-readonly`'s trust condition doesn't match a push-to-`main` subject, and there is no deploy job on `main` yet for an equivalent main-branch check to exercise (first one lands at TASK 0.4.1, and should assume `ndn-deploy` directly at that point, matching its now-`main`-only trust).

**Verified** (policy simulator, both directions, against the live IAM state):

```text
# ndn-deploy's trust policy, after the fix — no pull_request clause:
$ aws --profile ndn-prod iam get-role --role-name ndn-deploy \
    --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringLike'
{"token.actions.githubusercontent.com:sub": "repo:nourishthenerve/ndn-monolithic:ref:refs/heads/main"}

# ndn-ci-readonly can simulate against ndn-deploy specifically:
$ aws --profile ndn-prod iam simulate-principal-policy \
    --policy-source-arn arn:aws:iam::357601815388:role/ndn-ci-readonly \
    --action-names iam:SimulatePrincipalPolicy \
    --resource-arns arn:aws:iam::357601815388:role/ndn-deploy
iam:SimulatePrincipalPolicy   arn:aws:iam::357601815388:role/ndn-deploy   allowed

# ...and nothing else (proves the Resource scoping in its inline policy actually works):
$ aws --profile ndn-prod iam simulate-principal-policy \
    --policy-source-arn arn:aws:iam::357601815388:role/ndn-ci-readonly \
    --action-names iam:SimulatePrincipalPolicy \
    --resource-arns arn:aws:iam::357601815388:role/ndn-ci-readonly
iam:SimulatePrincipalPolicy   arn:aws:iam::357601815388:role/ndn-ci-readonly   implicitDeny
```

No downtime, no data touched, no application code affected — this is IAM-only and reversible (see Rollback).

**Third-party Actions are pinned to exact release tags, not commit SHAs.** SHA-pinning is the stricter supply-chain posture, but every SHA would have had to be copied by hand from an AI-summarised API response with no way to verify the transcription locally — a single wrong hex digit breaks the job outright with no way to catch it before pushing. Tag-pinning was verified directly against each project's GitHub Releases API and matches this repo's existing precedent (TASK 0.1.2 pinned exact npm versions, not lockfile-hash-level pinning).

## Follow-up fix: CI has been red on every run since this task landed (2026-08-09)

Discovered while opening the TASK 0.3.1 PR: every workflow run since this task introduced `ci.yml` — both `pull_request` and `push` events, five runs across PRs #6 and #7 — had actually failed. Branch protection is unavailable on GitHub Free (see below), so nothing was technically blocked from merging, but the pipeline's own claim to be "the only gate" (C-06) was silently false. Two independent, unrelated causes, both pre-existing and neither caused by TASK 0.3.1's own changes:

**1. `dorny/paths-filter` 403s on every `pull_request` run.** It resolves a PR's changed files via the GitHub REST API (`listFiles`), not a local git diff, which needs `pull-requests: read` on the token. The workflow only grants `contents: read` at the top level, so the call failed with `Resource not accessible by integration`, and `changes` failing cascaded into `quality`/`docs-lint` never running (their `needs.changes.outputs.*` conditions can't evaluate) and `ci-summary` failing. **Fix:** a job-level `permissions: { contents: read, pull-requests: read }` override on the `changes` job — job-level permissions replace rather than merge with the workflow-level block, so `contents: read` has to be restated. Verified with `actionlint`, which passes clean; the actual GitHub API behavior can't be verified locally (same limitation the original task's Verification section already notes for `dorny/paths-filter` specifically).

**2. `markdownlint-cli2-action@v24.2.0` fails on every table in the repo.** Fires `MD060` (table-column-style), a rule added to `markdownlint` after `.markdownlint-cli2.jsonc` was written — present in whatever `markdownlint-cli2` version this pinned action tag actually bundles, but not in the `markdownlint-cli2@0.18.1` used to verify TASK 0.2.1 locally (the drift was in the *rule set* between two versions, not an unpinned dependency at the Actions level — the action tag itself was already pinned). It flags nearly every table in the repo's existing padded-pipe style (`01-decisions.md`, `08-long-lead.md`, this file, `legacy-estate.md`, and TASK 0.3.1's new runbook) against MD060's default "compact" style. **Fix:** `"MD060": false` in `.markdownlint-cli2.jsonc`, with the same documented-exception pattern already used for `MD013`/`MD029`/`MD036` — the repo's table style is a deliberate readability choice, not a defect. Verified against `markdownlint-cli2@latest` (v0.23.2 / markdownlint v0.41.1) directly, since that's closer to what the unpinned-within-the-action tooling actually resolves: 0 errors across all 32 docs files, versus 8 files failing before the fix.

Neither fix touches anything TASK 0.3.1 added; both are pre-existing gaps in this task's own deliverable.

## Verification

Every step the workflow runs was run for real, locally, on this machine, after all edits:

```bash
pnpm install --frozen-lockfile                          # confirms the lockfile flag + lockfile itself
pnpm run lint && pnpm run typecheck                      # PASS
pnpm run test && pnpm run test:integration                # PASS (integration: 0 tests, passWithNoTests)
pnpm run test:coverage                                    # PASS, 100% against the 80% thresholds
pnpm run audit                                             # PASS, no known vulnerabilities at --audit-level=high
pnpm run format:check                                      # PASS
pnpm dlx markdownlint-cli2@0.18.1 "docs/**/*.md"          # PASS, 0 errors across 31 files
lychee --offline --no-progress 'docs/**/*.md'             # PASS, 15 links checked, 0 errors
gitleaks detect --source . --redact -v                    # PASS, 7 commits scanned, no leaks
```

Additionally: the whole workflow file was checked with `actionlint` (schema, expression syntax, and shellcheck across every `run:` block — installed via Homebrew for this task) and `action-validator` (JSON-schema validation), both clean. The `ci-summary` job's duration-computation shell logic and the `oidc-dry-run` job's `grep` assertions were each exercised against synthetic input using GNU `date`/`coreutils` (installed via Homebrew to match the GNU toolchain `ubuntu-latest` runners use, since macOS ships BSD `date`) to confirm the arithmetic and pattern matching are correct before they ever run against real GitHub/AWS API responses.

What could **not** be verified locally, because no local GitHub Actions runner exists: the actual OIDC token exchange in `oidc-dry-run` (hence: informational, not gating, on first landing), and the live behaviour of `dorny/paths-filter`, `markdownlint-cli2-action`, and `lychee-action` as GitHub Actions specifically (their underlying CLIs were verified directly instead).

## Repository security posture (2026-08-09, `gh` CLI access)

A repo-level security pass was run once `gh` was authenticated, covering everything C-06/NFR-03 imply beyond the pipeline itself:

- **Branch protection on `main` is unavailable at any price on the current plan.** Both the classic protection API and the newer rulesets API return `403 Upgrade to GitHub Pro or make this repository public` — GitHub Free restricts protected branches (and rulesets) to public repositories only; private-repo protection requires GitHub Team (org-wide, ~$4/seat/month) or Pro (per-user). **Decision (2026-08-09, reaffirmed): stay on GitHub Free.** The account owner chose process discipline (branch-per-task, no direct `main` commits) over the ~£3.20/month upgrade, explicitly considered and declined a second time when this was raised again. Making the repo public to get free protection was also considered and rejected: committed runbooks already contain real AWS account IDs and infrastructure detail. `main` therefore has no GitHub-enforced protection today — only convention. Revisit only if a second collaborator joins (see Owner actions).
- **Dependabot alerts** — enabled (`PUT /vulnerability-alerts`). Free on private repos regardless of plan; was off by default.
- **Dependabot security updates** (automated fix PRs for vulnerable dependencies) — enabled (`PUT /automated-security-fixes`). Also free; was off by default.
- **Native secret scanning** — unavailable on this plan (`404` on the alerts endpoint, same Free-plan gate as branch protection). Already covered independently: the `secret-scan` job's `gitleaks` run does the same job, for free, regardless of plan.
- **Private vulnerability reporting** — `404`, appears unavailable on Free for private repos; no free equivalent exists to substitute.
- **Org-level 2FA enforcement** — currently **off** (`two_factor_requirement_enabled: false` on the `nourishthenerve` org), and free to enable. **Decision (2026-08-09): leave off for now.** Raised with the account owner and explicitly deferred rather than enabled — revisit once a second collaborator has GitHub access, since it's the one control that protects every repo in the org at once, not just this one.
- **Collaborators, deploy keys, webhooks, repo secrets/variables** — audited via the API: one collaborator (the account owner, admin), zero deploy keys, zero webhooks, zero repo-level Actions secrets or variables. Nothing unexpected.
- **`ndn-deploy`'s OIDC trust policy** — found to accept an unscoped `pull_request` subject; fixed, see [above](#security-fix-tighten-ndn-deploys-oidc-trust-2026-08-09).

## Owner actions

1. **Watch the first real Actions run**, specifically the `oidc-dry-run` job (now PR-triggered, assuming `ndn-ci-readonly`). If it's green, move `needs.oidc-dry-run.result` into `ci-summary`'s failure condition (currently deliberately excluded — see Design decisions) so a future break in either OIDC trust policy actually blocks merges instead of just being visible.
2. **The cross-repo OIDC negative test** ("a token from another repository is rejected") named in TASK 0.1.1's Tests line still can't be automated from inside this repo — proving it requires an actual Actions run *from a different GitHub repository* attempting to assume `ndn-deploy`. Not attempted here; the trust policy's `StringLike` condition was inspected and confirmed static-allowlist-only. Flagging as a permanent gap rather than silently dropping it.
3. **When a second collaborator gets repo access**, revisit both deferred decisions above together: the GitHub Team upgrade (unlocks branch protection — at that point "no direct pushes to `main`" stops being enforceable by discipline alone) and org-level 2FA enforcement (protects every repo in the org, not just this one). Neither is urgent at one collaborator; both become materially more important at two.
4. **If/when branch protection is enabled**: require the `CI summary` status check (job name `ci-summary` in workflow `CI`) before merging, and require the branch to be up to date. This is what makes TASK 0.2.1's DoD ("cannot merge without green CI") literally true — until it's set, the workflow runs and reports but doesn't technically block anything.

## Cost delta

£0.00 — GitHub Actions on a private repo at this usage is inside the 2,000 free minutes/month (D-17); every third-party tool used (gitleaks, lychee, markdownlint-cli2, dorny/paths-filter) runs inside the existing runner at no additional cost; the `oidc-dry-run` job's AWS API calls (`sts:GetCallerIdentity`, `iam:SimulatePrincipalPolicy`) and the new `ndn-ci-readonly` IAM role are free, read-only. Dependabot alerts/security-updates are free on private repos. The GitHub Team upgrade discussed above (~£3.20/month) was evaluated and **not** applied — this pass stayed at £0.00 additional spend.

## Not done in this task (explicitly out of scope, deferred)

- Branch protection itself — the account owner explicitly chose to stay on GitHub Free (see above), so this stays undone by decision, not by gap.
- Org-level 2FA enforcement — explicitly deferred by the account owner (see above), not an oversight.
- Promoting `oidc-dry-run` to a required gate (owner action, above, pending first green run).
- The cross-repo OIDC negative test (owner action, above — structurally can't be scripted from here).
- Canary deploy, smoke test, auto-rollback, ephemeral per-PR environments — TASK 0.6.x. This task has nothing to deploy yet (first CDK stack is TASK 0.4.1); `quality`/`docs-lint`/`secret-scan` are the entire gate for now.
- Any change to `apps/web`/`apps/mobile` framework choice, or CDK application code — untouched, per TASK 0.1.2's own deferral.

## Rollback

Revert the branch/PR for the workflow/docs changes — nothing outside the repo depends on them (the `oidc-dry-run` job only reads AWS state). The IAM changes are separate from the git history and were applied directly against `ndn-prod` (`357601815388`), so reverting the branch does **not** undo them:

- `ndn-deploy`'s trust policy: restore the `pull_request` clause via `aws --profile ndn-prod iam update-assume-role-policy` — not recommended, this reintroduces the vulnerability described above.
- `ndn-ci-readonly` role: `aws --profile ndn-prod iam delete-role-policy --role-name ndn-ci-readonly --policy-name SimulateNdnDeployOnly` then `iam delete-role --role-name ndn-ci-readonly`.
- Dependabot alerts/security-updates: `DELETE /vulnerability-alerts` / `DELETE /automated-security-fixes` via `gh api` — not recommended, both are free and strictly additive security coverage.
