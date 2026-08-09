# Destructive-primitive lint rule (TASK 0.3.1)

**Date:** 2026-08-09 · **Task:** [05-execution-plan.md § TASK 0.3.1](../plan/05-execution-plan.md) · **Requirements:** C-03, §6.7 · **Risks:** R-06

## What this covers

The code-layer half of the two-layer data-protection guard (00-conventions.md's prohibition: "no `DeleteItem`, `DeleteObject`, `TRUNCATE`, `DROP`, or destructive migration against protected stores"). The IAM-layer half (runtime `Deny` policies) is TASK 0.3.2. This lands first so the guard exists before anything writes data.

A new workspace package, `packages/eslint-plugin-no-destructive` (`@ndn/eslint-plugin-no-destructive`), exports one ESLint rule — `ndn/no-destructive-primitives` — registered as `'error'` repo-wide in the root `eslint.config.js`, so it runs inside every package's existing `eslint .` and is enforced by `pnpm run lint`, already a required CI job (TASK 0.2.1). No CI YAML changes were needed.

## What the rule bans

| Category | Detection | Escape hatch |
|---|---|---|
| `DeleteItemCommand`, `DeleteObjectCommand`, `DeleteObjectsCommand` | any `Identifier` node with that name (imports, declarations, call sites — not just calls) | none |
| `DeleteRequest` (BatchWriteItem's delete branch) | same, `Identifier` node | none |
| Raw SQL | string/template literal matching `DELETE FROM`, `TRUNCATE TABLE`, or `DROP (TABLE\|DATABASE\|SCHEMA\|INDEX\|VIEW\|COLUMN)` — statement-shaped, not bare keywords, to avoid flagging ordinary UI copy ("Delete this workshop registration") | none |
| `s3:DeleteObject*` action strings | string literal matching `/^s3:DeleteObject/i` | **only** inside a file under `infra/` **and** inside an object literal with `effect`/`Effect: Deny` (or `Effect.DENY`) — the shape TASK 0.3.2's IAM deny statements will actually take |

## Why plain JavaScript, not TypeScript

ESLint's flat config (`eslint.config.js`) is loaded directly by Node with no build step — this repo has none yet (TASK 0.1.2 deliberately deferred bundling). A rule this central to every package's lint run can't depend on a TS→JS compile step that doesn't exist, so the plugin's source is plain ESM JavaScript, typechecked anyway via `checkJs`/JSDoc (`@type {import('eslint').Rule.RuleModule}` picked up `eslint`'s own shipped `.d.ts` and gave the rule's visitor callbacks real parameter types — verified this actually works, not just declared).

## The "no disable comments for this rule" requirement — and why it's a separate script, not a second rule

TASK 0.3.1's DoD says: "Do NOT: allow per-file disable comments for this rule." The first implementation attempt was a second ESLint rule that scanned comments for `eslint-disable` directives naming `ndn/no-destructive-primitives`. That's unsound: ESLint's core linter filters the final message list by **ruleId + location range** before any report reaches a formatter — a report from rule A with `ruleId: A` inside a range disabled *for rule A* is dropped regardless of what triggered it. A block-level `/* eslint-disable ndn/no-destructive-primitives */` would have silently suppressed the rule's own complaint about itself — the exact bypass the DoD line exists to prevent, and it would have looked like it worked in casual testing (the "next-line" form doesn't hit this, because it only suppresses the *following* line, not the comment's own — testing only that form would have missed the gap).

**Fix:** `scripts/check-no-disable-comments.mjs` — a scan over every git-tracked `.js`/`.mjs`/`.cjs`/`.ts`/`.tsx` file (via `git ls-files`, so it automatically respects `.gitignore`), looking for `eslint-disable`/`eslint-disable-line`/`eslint-disable-next-line` comments that either name `ndn/no-destructive-primitives` explicitly or carry no rule list at all (a bare disable suppresses every rule, including this one). It doesn't go through ESLint's linter at all, so ESLint's directive-suppression semantics don't apply to it — nothing short of editing the script itself can silence it. Wired into the root `lint` script (`pnpm -r run lint && node scripts/check-no-disable-comments.mjs`), so it's part of the same already-required CI job. The matching/detection logic (`isForbiddenDisableDirective`, `findForbiddenDisableComments`) lives in the plugin package and is unit-tested there; the script is a thin `git ls-files` + file-read wrapper around it.

Smoke-tested for real during this task: a scratch file containing `// eslint-disable-next-line ndn/no-destructive-primitives` above a `new DeleteObjectCommand({})` was added, the script caught it and exited 1, then the scratch file was removed (never committed).

**Follow-up fix (2026-08-09, before merge): a real false-positive in `findForbiddenDisableComments` itself.** The first version matched `eslint-disable` anywhere in a physical line via regex, not just at the start of an actual comment's own body. That misfired on this package's own files: the module header above (prose *describing* `` `/* eslint-disable ndn/no-destructive-primitives */` `` as an example, inside a real `//` comment) and `disable-comment-guard.test.js`'s own RuleTester-style string-literal fixtures (`'/* eslint-disable */'` as test *input data*, not a real directive) both got flagged as if they were live directives — caught when this branch's CI run finally reached the `quality` job for the first time (it never had before; PRs #6–#8 all failed earlier in the pipeline before `pnpm run lint` ran on this branch's actual content) and TASK 0.3.1's own deliverable failed its own guard.

Rewrote detection to use the TypeScript compiler's own scanner (`ts.createScanner`, `typescript` was already a repo devDependency — resolves fine from this package via Node's normal parent-directory `node_modules` lookup, matching the monorepo's "shared tooling lives once at the root" convention) instead of a text regex. The scanner correctly tokenizes real comments separately from string/template literal content, so it can never mistake either false-positive shape for a directive — this is the same "stay outside ESLint's own linter" property the script already needed, just applied one layer more precisely (comment-token-aware instead of line-text-aware). Two regression tests added directly reproducing both false-positive shapes.

## Fixtures — the guard's own test, per the task's Tests line

> "The guard's own test is the deliverable: a fixture file containing `DeleteObjectCommand` must fail lint; CI proves the failure. Negative: allowlisted deny-policy file passes."

Two files under `infra/src/__fixtures__/no-destructive/` (chosen over `tests/fixtures/` because the passing fixture has to physically live under `infra/` to exercise the path-scoped allowlist for real, not simulate it):

- **`should-fail.ts`** — one instance of every banned category, including an `s3:DeleteObject` action with `effect: 'Allow'` (proving the allowlist checks the effect, not just the directory).
- **`should-pass.ts`** — the one shape the allowlist actually permits: `effect: 'Deny'`, `actions: ['s3:DeleteObject', 's3:DeleteObjectVersion']`, under `infra/`.

Both are excluded from the normal recursive `pnpm -r lint` (a global `ignores` entry in `eslint.config.js` — `should-fail.ts` failing lint by design would otherwise break the required CI gate) but typecheck cleanly as ordinary strict TypeScript, since `tsc` doesn't consult ESLint's ignore list.

`pnpm lint:no-destructive` (`eslint --no-ignore infra/src/__fixtures__/no-destructive`) force-lints just that directory, bypassing the ignore entry. Confirmed: exits 1 with exactly 11 errors, all against `should-fail.ts`; `should-pass.ts` contributes zero.

## RuleTester coverage (the automated half of "CI proves the failure")

`no-destructive-primitives.test.js` uses ESLint's `RuleTester` directly (not a fixture file — see below for why the two aren't the same test) against every banned category, plus the allowlist's edge cases: Deny outside `infra/` (still rejected — the allowlist is `infra/` **and** Deny, not either), Allow inside `infra/` (still rejected), no `effect` property at all, no enclosing object literal, a spread element among the properties, and a non-string/non-MemberExpression `effect` value — the branches `objectHasDenyEffect` needs to fall through correctly. `disable-comment-guard.test.js` covers the directive-matching logic directly (bare vs. named vs. unrelated-rule disables, block vs. line vs. next-line forms, correct line-number reporting across a multi-line file).

One real self-reference bug surfaced writing this: the rule's own **test file** (not its implementation) trips the rule when linted for real, because RuleTester's `code:` fixtures are string literals whose *contents* are the banned patterns as text — that's the whole point of testing them. `eslint.config.js` has one targeted override, `ndn/no-destructive-primitives: 'off'` scoped to `packages/eslint-plugin-no-destructive/src/**/*.test.js` only. (The rule's own implementation files needed no such exception — they reference the banned names only as string-array elements and regex literals, neither of which the rule's own checks match.)

## Verification

```bash
pnpm install --frozen-lockfile
pnpm run lint            # 11/11 packages clean + disable-comment guard clean
pnpm run typecheck       # 11/11 packages clean, including the JS-via-checkJs plugin package
pnpm run test            # 12 files, 22 tests, all pass (12 of them in this task's own package)
pnpm run test:integration
pnpm run test:coverage   # 100% stmts/lines, 94.23% branches, 100% funcs — all ≥ 80% threshold
pnpm run audit           # no known vulnerabilities
pnpm run format:check    # clean
pnpm run lint:no-destructive   # exits 1, 11 errors, all in should-fail.ts
```

All run for real on this machine after every edit, matching `.github/workflows/ci.yml`'s `quality` job step-for-step.

## Cost delta

£0.00 — lint tooling only, no AWS resources touched.

## Not done in this task (explicitly out of scope, deferred)

- IAM-layer `Deny` policies and the break-glass role — TASK 0.3.2. This task is the code-layer half only; `should-pass.ts` shows the *shape* 0.3.2's policies need to take to pass this rule, it doesn't create any real policy.
- Soft-delete/audit repository primitives — TASK 0.3.3.
- Schema separation for lawful erasure — TASK 0.3.4.
- Extending the rule to JSON/YAML CloudFormation templates — not needed yet; TASK 0.4.1 authors infra as CDK TypeScript, not raw CloudFormation, so the `s3:DeleteObject*` check only needs to understand JS/TS object literals for now.

## Rollback

Revert the branch/PR. Nothing outside the repo depends on any of this — no AWS resources, no CI config changes (the existing `pnpm run lint`/`pnpm run test` CI steps just do more work now).
