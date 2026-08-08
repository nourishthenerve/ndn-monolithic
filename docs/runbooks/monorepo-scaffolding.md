# Monorepo scaffolding, linting, formatting, type checking (TASK 0.1.2)

**Date:** 2026-08-08 · **Task:** [05-execution-plan.md § TASK 0.1.2](../plan/05-execution-plan.md) · **Decisions:** D-15, D-16

## What this covers

Laid down the pnpm/TypeScript monorepo skeleton every later task builds on: root tooling config (lint, format, typecheck, test) plus the ten workspace packages named in `00-conventions.md` §Layout. Scaffolding only — no application logic, no CDK stacks, no framework choice for `apps/web`/`apps/mobile` yet (deliberately deferred; see "Not done" below).

## Local tooling installed first

This machine had neither `pnpm` nor a Node 22 install (only Homebrew's Node v25.9.0, and no `corepack`). Per the account owner's explicit preference — ask before working around a missing tool rather than routing around the gap — both were installed properly rather than patched over:

- `pnpm` 11.20.0 via Homebrew.
- `fnm` via Homebrew, managing Node versions; Node 22.23.2 installed and set as the `fnm` default (matches the Lambda arm64 runtime target, ADR-0001). `fnm env --use-on-cd` wired into `~/.zshrc` so new shells pick it up automatically.

Root `package.json` pins `"engines": { "node": ">=22 <23" }` and `"packageManager": "pnpm@11.20.0"` exactly, since the local default now genuinely is Node 22.

## Layout created

Ten pnpm workspace packages (`pnpm-workspace.yaml`: `apps/*`, `packages/*`, `services/*`, `infra`, `tests`):

- `apps/web` (`@ndn/web`), `apps/mobile` (`@ndn/mobile`)
- `packages/api-client`, `packages/shared-types`, `packages/i18n`, `packages/ui`
- `services/api`, `services/workers`
- `infra` (`@ndn/infra`) — no `aws-cdk-lib`/`constructs` yet; those land with real CDK code in TASK 0.4.1, per the task's own "Do NOT add runtime dependencies not needed by a shipped feature"
- `tests` (`@ndn/tests`) — one package with empty `integration/`, `e2e/`, `load/` subdirectories; no Playwright wiring yet

Each of the 9 code packages has an identical minimal shape: `package.json` (name, `lint`/`typecheck`/`test` scripts, **no devDependencies** — all shared tooling lives once at the workspace root; pnpm puts the root's `node_modules/.bin` on `PATH` for every workspace package's scripts), `tsconfig.json` extending the root `tsconfig.base.json`, a minimal `vitest.config.ts`, and one trivial `src/index.ts` + `src/index.test.ts` proving the harness runs (per the task's own Tests line).

## Root tooling

- **`tsconfig.base.json`** — `strict: true`, `noUncheckedIndexedAccess: true` (both named explicitly in the task step), `target: ES2022`, `module`/`moduleResolution: NodeNext`, `noEmit: true` (nothing builds/bundles yet).
- **`eslint.config.js`** — ESLint flat config (single file at repo root; flat config resolves upward automatically, so no per-package config needed). `typescript-eslint` recommended, `eslint-plugin-import-x` for the "import ordering" requirement (`import-x/order`, grouped + alphabetized), `eslint-config-prettier` last so formatting rules don't fight Prettier.
- **`.prettierrc`** / **`.prettierignore`** — the latter deliberately excludes `docs/**` and root `*.md` so this task's diff doesn't reformat unrelated committed markdown (the planning brief, existing runbooks).
- **`vitest.config.ts`** (root) — the one place coverage thresholds are configured: `provider: 'v8'`, 80% lines/functions/branches/statements, via `test.projects` aggregating all ten packages. This is what makes "coverage thresholds configured but not yet enforced" literally true — the numbers exist here, but nothing in this task (no CI yet) ever runs it as a gate.

## Two deviations from the literal plan text, both technical necessities discovered during implementation

1. **`eslint-plugin-import` → `eslint-plugin-import-x`.** The plan doesn't name a specific package, only "import ordering". `eslint-plugin-import`'s peer range tops out at ESLint `^9`; latest ESLint is 10.x. `eslint-plugin-import-x` (the actively-maintained ESM-native fork) explicitly supports `^10.0.0`, so that's what's installed.
2. **Added `eslint-import-resolver-typescript`.** `eslint-plugin-import-x`'s bundled `flatConfigs.typescript` preset threw `"typescript with invalid interface loaded as resolver"` against this dependency combination — a bug/mismatch, not a config error on our side (confirmed by removing that one preset and testing in isolation). Worked around by not using that preset and instead wiring the standard `settings['import-x/resolver'] = { typescript: true }` pointing at `eslint-import-resolver-typescript` directly, which resolves TypeScript's `./index.js`-referring-to-`./index.ts` (NodeNext) convention correctly. Verified: lint is clean across all 10 packages with this wiring.

## Supply-chain note: dependency version pinning

pnpm 11's new install-time policy flagged `eslint@10.8.1` (published 2026-08-07, less than a day before this install) under its `minimumReleaseAge` check. Rather than add it to `minimumReleaseAgeExclude` (which pnpm offered to do automatically), every root devDependency was pinned to an **exact** version at least ~2 weeks old instead of the latest patch (`eslint` 10.8.0 not 10.8.1; `typescript-eslint` 8.65.0 not 8.66.0; others were already old enough). No `minimumReleaseAgeExclude` entries needed. `unrs-resolver`'s postinstall script (a transitive dep of `eslint-plugin-import-x`, blocked by pnpm's build-script-approval gate by default) was inspected before approving: it only runs `napi-postinstall`'s standard prebuilt-native-binary selection for the current platform — no compilation, no network calls beyond npm's own package resolution. Approved via `pnpm-workspace.yaml`'s `allowBuilds: { unrs-resolver: true }`.

## Verification

```
pnpm install                                    # clean, no supply-chain policy violations
pnpm -r run lint && pnpm -r run typecheck && pnpm -r run test   # all 10 packages green
pnpm run format:check                           # clean after one `pnpm run format` pass
pnpm exec vitest run --coverage                  # 100% against the configured 80% thresholds
```

All run from a fresh `pnpm install` on this machine (Node 22.23.2, pnpm 11.20.0).

## Cost delta

£0.00 — no AWS resources touched; this is local tooling and repo scaffolding only.

## Not done in this task (explicitly out of scope, deferred)

- Any framework choice for `apps/web` (React/Vite/etc.) or `apps/mobile` (Expo, per ADR-0013) — no ADR pins this yet and the task doesn't call for it.
- CDK app code in `infra/` — TASK 0.4.1.
- Playwright wiring in `tests/e2e` — whichever task first needs it.
- Coverage threshold *enforcement* in CI, and CI itself — TASK 0.2.1.
- The destructive-primitive ESLint rule — TASK 0.3.1, a separate deliverable.

## Rollback

Revert the branch/PR — nothing outside the repo (no AWS resources, no CI yet) depends on any of this.
