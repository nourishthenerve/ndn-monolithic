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
| `oidc-dry-run` | always, informational | proves the `ndn-deploy` OIDC role still has exactly the access TASK 0.1.1 granted it |
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

**`oidc-dry-run` closes a loop TASK 0.1.1 explicitly deferred, but lands informational-only.** TASK 0.1.1's own Tests line calls for "assume `ndn-deploy` from a CI dry-run and confirm it can `cloudformation:DescribeStacks` and cannot `iam:CreateUser`" — its runbook (`aws-account-baseline.md`) notes this was "deferred to TASK 0.2.1, where CI first exists to run it from." That's now. The job assumes the role via OIDC and re-runs the exact `iam simulate-principal-policy` check already verified once by hand in TASK 0.1.1 — a read-only call, nothing mutates. It is deliberately **excluded** from `ci-summary`'s pass/fail gate on this first landing: it's the first time this trust policy is exercised from a live Actions run rather than a manual CLI call, and there's no way to dry-run GitHub Actions itself locally. Watch the first real run; once it's green, promote it into `ci-summary`'s required list (see Owner actions below). The role ARN (`arn:aws:iam::357601815388:role/ndn-deploy`) is inlined rather than stored as a repo variable — it's already public in this repo's own committed runbook and an ARN alone grants no access without satisfying the OIDC trust condition, so gating it behind manual repo configuration would only add friction, not safety.

**Third-party Actions are pinned to exact release tags, not commit SHAs.** SHA-pinning is the stricter supply-chain posture, but every SHA would have had to be copied by hand from an AI-summarised API response with no way to verify the transcription locally — a single wrong hex digit breaks the job outright with no way to catch it before pushing. Tag-pinning was verified directly against each project's GitHub Releases API and matches this repo's existing precedent (TASK 0.1.2 pinned exact npm versions, not lockfile-hash-level pinning).

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

## Owner actions (cannot be scripted — no `gh` CLI, no repo-admin API access)

1. **Branch protection on `main`:** require the `CI summary` status check (job name `ci-summary` in workflow `CI`) before merging, and require the branch to be up to date. GitHub → repo Settings → Branches → branch protection rule for `main` → "Require status checks to pass" → add `CI summary`. This is what makes TASK 0.2.1's DoD ("cannot merge without green CI") literally true — until this is set, the workflow runs and reports but doesn't block anything.
2. **Watch the first real Actions run**, specifically the `oidc-dry-run` job. If it's green, move `needs.oidc-dry-run.result` into `ci-summary`'s failure condition (currently deliberately excluded — see Design decisions) so a future break in the `ndn-deploy` trust policy or its permissions actually blocks merges instead of just being visible.
3. **The cross-repo OIDC negative test** ("a token from another repository is rejected") named in TASK 0.1.1's Tests line still can't be automated from inside this repo — proving it requires an actual Actions run *from a different GitHub repository* attempting to assume this role. Not attempted here; the trust policy's `StringLike` condition was inspected and confirmed static-allowlist-only in TASK 0.1.1. Flagging as a permanent gap rather than silently dropping it.

## Cost delta

£0.00 — GitHub Actions on a private repo at this usage is inside the 2,000 free minutes/month (D-17); every third-party tool used (gitleaks, lychee, markdownlint-cli2, dorny/paths-filter) runs inside the existing runner at no additional cost; the `oidc-dry-run` job's two AWS API calls (`sts:GetCallerIdentity`, `iam:SimulatePrincipalPolicy`) are free, read-only IAM/STS operations.

## Not done in this task (explicitly out of scope, deferred)

- Branch protection itself (owner action, above).
- Promoting `oidc-dry-run` to a required gate (owner action, above, pending first green run).
- The cross-repo OIDC negative test (owner action, above — structurally can't be scripted from here).
- Canary deploy, smoke test, auto-rollback, ephemeral per-PR environments — TASK 0.6.x. This task has nothing to deploy yet (first CDK stack is TASK 0.4.1); `quality`/`docs-lint`/`secret-scan` are the entire gate for now.
- Any change to `apps/web`/`apps/mobile` framework choice, or CDK application code — untouched, per TASK 0.1.2's own deferral.

## Rollback

Revert the branch/PR. Nothing outside the repo depends on this: no AWS resources are created (the `oidc-dry-run` job only reads), and branch protection — the one GitHub-side setting this task touches by *documentation* rather than by API — was never actually enabled by this change, so there's nothing server-side to unwind.
