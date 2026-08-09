# Soft-delete + audit primitives (TASK 0.3.3)

**Date:** 2026-08-09 · **Task:** [05-execution-plan.md § TASK 0.3.3](../plan/05-execution-plan.md) · **Depends on:** 0.3.1

## What this covers

The application-code primitives that every future entity repository (patient, diagnosis, care plan, assessment, appointment, …) will be built on: a base class that stamps `created_at`/`updated_at`/`status` on every write and only ever soft-deletes, an append-only audit writer, and a versioned-record helper for `docs/plan/04-data-model-rbac.md`'s "Versioned, append-only" entities. This is the third and last piece of the M0.3 data-protection guard, after TASK 0.3.1 (code-layer lint rule) and TASK 0.3.2 (IAM-layer `Deny`).

No DynamoDB table is deployed yet (TASK 0.4.1 is the first task that deploys real application infrastructure — see `docs/runbooks/iam-deny-guardrails.md`), so all five files live in `services/api/src/` behind a small storage interface (`KeyValueStore<T>`) rather than an AWS SDK client. `InMemoryStore`/`InMemoryAuditLog` are today's implementations; a DynamoDB-backed `KeyValueStore`/`AuditWriter` can be substituted later without either repository class changing.

## What was built

- **`services/api/src/types.ts`** — `RecordStatus = 'active' | 'deleted'` and `BaseRecord` (`created_at`, `updated_at`, `status`).
- **`services/api/src/clock.ts`** — `Clock` interface + `systemClock`. 00-conventions.md: "time is injectable — no test reads the wall clock"; every timestamp `Repository`/`VersionedRepository` write goes through an injected `Clock`, so tests use a deterministic stepping clock instead.
- **`services/api/src/errors.ts`** — `AppError` (`code` + `message`), the first use of 00-conventions.md's "typed `AppError` with a stable code" convention in this repo.
- **`services/api/src/store.ts`** — `KeyValueStore<T>` interface + `InMemoryStore<T>`, the storage seam described above.
- **`services/api/src/audit.ts`** — `AuditWriter` interface + `InMemoryAuditLog`: `write()` only, no method that removes an entry. Matches `docs/plan/04-data-model-rbac.md`'s audit event shape (who/what/when/where → `actor`/`action`+`entityType`/`at`/`entityId`).
- **`services/api/src/repository.ts`** — `Repository<T extends BaseRecord>`: `create`, `update`, `softDelete`, `findById`. `create`/`update`/`softDelete` each stamp `updated_at` and write an audit entry; `create` also stamps `created_at` (`update`/`softDelete` preserve it from the existing record — never recomputed). **There is no `delete` method** — `softDelete` sets `status: 'deleted'` and the record stays readable via `findById`. `update` and `softDelete` both require the existing record to be `active` (via a private `requireActive` helper) — attempting either against a missing or already-deleted record throws `AppError`, so a soft-deleted record can never be mutated in place.
- **`services/api/src/versioned-repository.ts`** — `VersionedRepository<T extends VersionedRecord>`: `createVersion`, `getVersion`. Each `(id, version)` pair maps to its own store key (`` `${id}#v${version}` ``), so version N+1 is a distinct row from version N — there is no operation that touches an existing version's key. `createVersion` throws `AppError('VERSION_ALREADY_EXISTS', …)` if that key is already occupied, rather than overwriting it.

## Tests (`docs/plan/05-execution-plan.md`'s Tests line, verified directly)

| Tests line requirement | Where it's proven |
|---|---|
| "delete" sets a status flag and the record remains readable by ID | `repository.test.ts` → `Repository.softDelete` → *"sets a status flag rather than removing the record — it stays readable by id"* |
| audit entry written for every mutation | `repository.test.ts` (create/update/soft-delete each assert on `audit.list()`) and `versioned-repository.test.ts` → *"writes an audit entry for every version created"* |
| version N+1 never mutates version N | `versioned-repository.test.ts` → *"version N+1 never mutates version N"* (writes v1 and v2, re-reads both, asserts each is untouched by the other) |
| Negative: attempting an in-place overwrite of a clinical record throws | `versioned-repository.test.ts` → *"throws rather than in-place-overwriting an existing version"* (re-reads v1 afterward to confirm the rejected write left it untouched); `repository.test.ts` → *"throws rather than in-place-overwriting a soft-deleted record"* |

Two more tests assert the DoD directly by inspecting `Object.getOwnPropertyNames(Repository.prototype)`/`InMemoryAuditLog.prototype` for the absence of `delete`/`remove`/`clear`, rather than relying only on "no such method is called anywhere" — a future addition of one of those methods fails these tests immediately even before anything calls it.

`store.ts` and `clock.ts` also get direct unit tests (`store.test.ts`, `clock.test.ts`) rather than only being exercised indirectly through the repository tests.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm run lint            # 12/12 packages clean
pnpm run typecheck       # 12/12 packages clean
pnpm run test            # 18 files, 52 tests, all pass (20 of them new, in services/api —
                          # index.test.ts's placeholder predates this task)
pnpm run test:integration
pnpm run test:coverage   # pre-existing gap unrelated to this task: root coverage config only
                          # instruments eslint-plugin-no-destructive's files across every
                          # package (same gap TASK 0.3.1/0.3.2's own runbooks reported)
pnpm run audit            # no known vulnerabilities
pnpm run format:check     # clean
```

All run for real on this machine after every edit, matching `.github/workflows/ci.yml`'s `quality` job step-for-step.

## Cost delta

£0.00 — application code only, no AWS resources touched.

## Not done in this task (explicitly out of scope, deferred)

- Wiring `Repository`/`VersionedRepository` up to real entities (patient, diagnosis, care plan, …) — Phase 2/3, once those data shapes and the real DynamoDB table (TASK 0.4.1+) exist.
- A DynamoDB-backed `KeyValueStore`/`AuditWriter` implementation — same dependency; `InMemoryStore`/`InMemoryAuditLog` are the only implementations today.
- The clinician-private-field projection (R-09) — a separate chokepoint, TASK 3.2.x per `docs/plan/04-data-model-rbac.md`.
- Schema separation for lawful erasure — TASK 0.3.4.

## Rollback

Revert the branch/PR. Nothing outside the repo depends on any of this — no AWS resources, no CI config changes, and nothing else in the repo imports from `services/api/src/{repository,versioned-repository,audit,store,clock,errors,types}.ts` yet.
