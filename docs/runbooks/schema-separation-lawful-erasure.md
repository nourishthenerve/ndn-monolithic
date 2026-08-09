# Schema separation for future lawful erasure (TASK 0.3.4)

**Date:** 2026-08-09 · **Task:** [05-execution-plan.md § TASK 0.3.4](../plan/05-execution-plan.md) · **Depends on:** 0.3.3

## What this covers

The generic primitive every future person record (patient, clinician, …) will be built on: a `clinical{}` / `personal{}` split so that a future, human-authorised, field-level erasure of non-clinical data (name, contact details, marketing preferences) needs no schema migration — only clinical data need ever be retained under C-03's "never delete" prohibition. This resolves the *shape* of R-04's tension, not the tension itself: whether and when erasure is lawful under GDPR against a never-delete platform is still a DPO/solicitor decision (LL-06), unchanged by this task.

## What was built

- **`services/api/src/person-record.ts`** — `PersonRecord<Clinical, Personal>` extends `BaseRecord` with two readonly attribute sets, `clinical` and `personal`, as distinct top-level properties (never nested inside one another, never flattened into a single bag). Four helpers: `projectClinical`/`projectPersonal` read one set without exposing the other; `withClinical`/`withPersonal` return a new record with one set replaced, leaving the other set's object reference untouched. There is no combined `withBoth` and no erasure/redaction helper — only whole-set replacement, by the caller, of one side at a time.

## Tests (`docs/plan/05-execution-plan.md`'s Tests line, verified directly)

| Tests line requirement | Where it's proven |
|---|---|
| Projection helpers prove the two sets are independently addressable | `person-record.test.ts`: `projectClinical`/`projectPersonal` return the exact stored object for their own set (`toBe`, not `toEqual`); `withClinical` and `withPersonal` each leave the *other* set's reference untouched; a composed "clinical then personal" update proves order doesn't matter and the original record is never mutated |

An additional test (*"a field-level change to personal needs no rewrite of clinical"*) asserts directly against the DoD's premise: replacing one field inside `personal{}` leaves `clinical` at the same object reference — no migration, no rewrite, no touch.

## Verification

```bash
pnpm install --frozen-lockfile
pnpm run lint            # clean
pnpm run typecheck       # clean
pnpm run test            # all pass, person-record.test.ts new
pnpm run test:integration
pnpm run audit            # no known vulnerabilities
pnpm run format:check     # clean
```

All run for real on this machine after every edit, matching `.github/workflows/ci.yml`'s `quality` job step-for-step.

## Cost delta

£0.00 — application code and documentation only, no AWS resources touched.

## Not done in this task (explicitly out of scope, deferred)

- Wiring `PersonRecord` up to a real entity (patient, clinician, …) — Phase 2/3, same as `Repository`/`VersionedRepository` (TASK 0.3.3).
- Any erasure or redaction code path — explicitly prohibited by this task's Do NOT and gated on the DPO/solicitor sign-off in `docs/compliance/dpia-skeleton.md` (R-04, LL-06).
- Resolving R-04 itself (GDPR erasure vs C-03 never-delete) — this task only makes a future resolution cheap to implement, it does not decide one.

## Rollback

Revert the branch/PR. Nothing outside the repo depends on `services/api/src/person-record.ts` yet — no AWS resources, no CI config changes, and no other file imports from it.
