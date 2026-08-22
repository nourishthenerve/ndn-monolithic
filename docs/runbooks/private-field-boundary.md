# The clinician-private field boundary (TASK 2.1.2)

**Date:** 2026-08-21 · **Task:** [05-execution-plan.md § TASK 2.1.2](../plan/05-execution-plan.md) · **Milestone:** M2.1 · **Requirements:** FR-DP-05, NFR-06 · **Risk:** [R-09](../plan/02-risk-register.md) · **Depends on:** 2.1.1, 0.3.3, 0.3.4

## The invariant

> A `private{}` attribute never leaves this process for anyone the RBAC matrix does not grant a read of the private half of that specific resource.

That is the whole of it. `docs/plan/04-data-model-rbac.md` states where it is enforced — "at the repository layer … not in the handler, not in the view: one chokepoint" — and `docs/plan/02-risk-register.md`'s **R-09** is the only risk in the register rated **Critical**. `docs/plan/09-self-audit.md`'s red-team names the four exits it expects to fail through: *"an export, a log line, an error message, a cache."* Three of the four are closed below; the fourth (a cache) has nothing to cache yet — API responses are `no-store` (R-14, ADR-003) and no response cache exists.

The chokepoint is built at 2.1.2 rather than at 3.2.x — one phase before the first real entity is wired through it — for the same reason `person-record.ts` (TASK 0.3.4) split clinical from personal before any patient existed: the boundary is cheap to build against an empty system and expensive to retrofit onto a populated one. **3.2.x remains the task that wires assessments through it.**

## What was built

- **`services/api/src/projection.ts`** (new) — the chokepoint. One file, and every function in it keys off a single marker, `PRIVATE_FIELD_KEY = 'private'` (the same string as `FieldSet`'s `'private'` member). There is no allow-list of "sensitive field names" to keep in sync.
  - `projectFor(principal, record, resource)` — strips every `private` attribute, at every depth, inside arrays as well as objects, **unless** `can(principal, 'read', { …resource, fieldSet: 'private' })` allows it. `projectAllFor` is the same decision applied to a list.
  - `Projected<T>` / `Unprojected<T>` — two phantom brands (`declare const … : unique symbol` keys; nothing is added at runtime).
  - `serialiseResponse(body)` — the sanctioned JSON exit. Its `ResponseValue` type accepts scalars and `Projected<unknown>`, and nothing else.
  - `containsPrivateField(value)` / `redactPrivateText(text)` — the runtime half, for the two exits where a private attribute is *never* acceptable regardless of who is asking.
- **`services/api/src/repository.ts`, `services/api/src/versioned-repository.ts`** — every method that hands a record back now returns `Unprojected<T>`. Writes are branded as well as reads: a freshly created record echoed straight back to its author is exactly the "forgot to project" bug the brand exists to catch.
- **`services/api/src/logger.ts`** — refuses to write a line whose fields contain a `private` key, at any depth, and the check runs **before** the sampling draw.
- **`services/api/src/errors.ts`** — `AppError`'s message is redacted on construction.
- **`vitest.config.ts`** — a per-file coverage threshold of 100% for `projection.ts` alone.

## Why it is a compile error and not a code-review item

The plan's requirement is that "forgot to project" is caught by the compiler rather than by a reviewer or a missing test. Three types do that:

| Type | What holds it | Effect |
|---|---|---|
| `Unprojected<T>` | what every repository read and write returns | the value a handler holds is visibly the one with its private half intact |
| `Projected<T>` | what `projectFor` returns, and nothing else | the only record shape `serialiseResponse` accepts |
| `Action` (from 2.1.1) | `'create' \| 'read' \| 'update'` | there is no delete to authorise |

```ts
const record = await repository.findById(id);          // Unprojected<Assessment> | undefined
serialiseResponse({ item: record });                   // ✗ compile error
serialiseResponse({ item: projectFor(principal, record, resource) });  // ✓
```

`projection.test.ts` pins this with three `// @ts-expect-error` assertions. They are checked by `pnpm -r typecheck`, not by `pnpm test` — an unused `@ts-expect-error` is itself a compile error, so the day one of those lines starts compiling, typecheck goes red.

**There is no `raw` or `skipProjection` option, and there will not be one.** Adding one is explicitly out of bounds (05-execution-plan.md TASK 2.1.2's "Do NOT"). `unprojected()` is not an escape hatch in the other direction either — it only *adds* the obligation to project, and branding something `Unprojected` never gets it past `serialiseResponse`.

## Deny by default, twice over

Two decisions in `projectFor` fail closed, and both are worth knowing before writing an endpoint:

1. **Only an entity the data model gives a `private{}` half can ever keep one.** `PRIVATE_BEARING_ENTITY_TYPES` holds exactly one member today, `'assessment'`. `can()` only splits visible from private on the two assessment rows of the matrix, so without this list "may you read the private half of a diagnosis?" would quietly collapse into "may you read a diagnosis?" — and a patient may read their own diagnosis. **Adding an entity with a private half means adding it to that list and to `docs/plan/04-data-model-rbac.md`'s matrix, in that order.**
2. **`projectFor` answers one question only** — may the private half go out? Whether the principal may read the record *at all* is the caller's own `can()` check. A missing authorisation is therefore never disguised as an empty projection.

An inoperative account (`pending`, `declined`, `suspended`, `deactivated`) is gated by `can()` before role is considered, so it never sees a private half either.

## The three closed exits

| Exit | Mechanism | Failure mode |
|---|---|---|
| **JSON response** | `serialiseResponse` accepts `Projected<…>` only | compile error at the call site |
| **Log line** | `containsPrivateField` on the fields, before the sample draw | `AppError('PRIVATE_FIELD_IN_LOG')` — the request fails |
| **Error message** | `redactPrivateText` in `AppError`'s constructor | message truncated at the `private:` key, `[redacted: private field]` appended |

Two of the three are deliberately loud rather than silent. **Refusing to log is a choice**: an unlogged request is a smaller failure than a leaked clinical note, and R-09 is the register's only Critical. The error-message path is the exception — it redacts rather than throws, because an error constructor that throws replaces the real failure with a confusing one.

The response serialiser deliberately does **not** run `containsPrivateField`. An assigned sub-clinician is *supposed* to receive `private{}`; there the guarantee is the `Projected` type, which records that a decision was taken, not a content scan that cannot tell an authorised private field from an unauthorised one.

`redactPrivateText` drops everything from the `private:` key onward instead of brace-matching the JSON value that follows. An error message losing its tail is a far cheaper failure than an error message carrying clinical notes.

## Negative test per endpoint, forever (NFR-06)

This is the convention every endpoint from Phase 2 on owes, and it is not optional. **Every endpoint that reads a private-bearing entity ships with at least one test that asserts a denied principal does not receive `private{}`** — not that they receive a 403, but that the body they do receive has no private attribute in it.

Add one like this:

```ts
it('does not leak private{} to the owning patient', async () => {
  const response = await handler(eventFor(OWNING_PATIENT), context);
  expect(containsPrivateField(JSON.parse(response.body))).toBe(false);
});
```

Use `containsPrivateField` on the parsed response body rather than a `toEqual` against an expected shape: `toEqual` passes for the wrong reason if the endpoint later starts nesting its payload one level deeper, and the walk does not.

The cases to cover, per endpoint, are the matrix's `—` columns for the private row: **the owning patient, any other patient, an unassigned sub-clinician**, and any inoperative account status. `projection.test.ts` covers all four at the chokepoint; the per-endpoint test proves the endpoint actually goes *through* the chokepoint.

## Coverage as a CI condition

R-09's mitigation names the number — "100% coverage on the boundary" — so `vitest.config.ts` holds `projection.ts` to 100% lines/branches/functions/statements on its own, separately from the repo-wide 80%:

```ts
'**/services/api/src/projection.ts': { lines: 100, functions: 100, branches: 100, statements: 100 }
```

`pnpm test:coverage` runs in the `quality` job of `.github/workflows/ci.yml`, so a new untested branch in `projection.ts` fails the build with a named error:

```text
ERROR: Coverage for branches (87.5%) does not meet "**/services/api/src/projection.ts" threshold (100%)
```

That message was reproduced deliberately during this task (against `repository.ts`) to prove the glob threshold engages rather than being silently ignored.

A practical consequence: **keep `projection.ts` small.** Every `??`, `?.` and ternary added to it is a branch someone has to write a test for. `isPlainObject` carries a comment explaining why it has no `Array.isArray` check — the branch would be unreachable from both of its callers, and an unreachable branch cannot be covered.

## Two deviations from the planned interface

`05-execution-plan.md` sketches the interface as:

```ts
export type Projected<T> = T & { readonly __projected: unique symbol };
export function projectFor<T>(principal: Principal, record: T): Projected<Partial<T>>;
```

Both parts are adjusted, and both adjustments are visible in the code:

1. **`unique symbol` inline is not valid TypeScript** — it is only legal on a `const` or `readonly static` declaration. The brand is a `declare const projectedBrand: unique symbol` used as a computed key instead. Same semantics, compiles.
2. **`projectFor` takes the `Resource` as a third argument.** `can()` decides on relationship, not role alone — a sub-clinician sees the private half of an *assigned* patient's assessment and nothing else — and a bare generic `T` cannot carry `entityType` / `ownerPatientId` / `assignedClinicianId`. Deriving them from the record would mean either constraining `T` (which stops it being the general primitive the plan asks for) or guessing, which is the one thing a deny-by-default layer must not do.

## What this task did *not* do

The existing public handlers (`content-repository.ts`'s `createContentReadHandler`, workshops, testimonials, registrations) still call `JSON.stringify` directly. They are unchanged on purpose: none of their entities has a `private{}` half in `docs/plan/04-data-model-rbac.md`, and they are unauthenticated public reads with no `Principal` to project against — there is nothing for `projectFor` to decide. They adopt `serialiseResponse` as and when they gain an authenticated read path. **Every new endpoint from here on uses it from the start.**

`docs/plan/02-risk-register.md`'s R-09 row already carried the `2.1.2` (chokepoint) / `3.2.x` (wiring) amendment — it was made during the Phase 2 elaboration (commit `8a9c688`). This task adds the pointer to this runbook and nothing else to that row.

## Verification

```bash
pnpm -r lint          # 12/12 packages clean
pnpm -r typecheck     # 12/12 packages clean — this is what checks the @ts-expect-error assertions
pnpm run test         # 83 files, 822 tests, all pass
pnpm run test:coverage
```

`pnpm test:coverage` reports `projection.ts` at 100% on all four metrics; it does not appear in the text reporter's list of files with uncovered lines.

## If the boundary is ever breached

1. **Do not delete anything** — C-03 and `00-conventions.md`'s prohibition still hold, and an audit row proving what was disclosed is worth more than a tidy table.
2. Identify the exit from the three above. The `AppError` code tells you which: `PRIVATE_FIELD_IN_LOG` is the log path; a response leak has no code, because it means something bypassed `serialiseResponse` — find the `JSON.stringify` that did it.
3. Query the audit log (`GET /audit?date=`, TASK 2.1.3 — see [audit-log.md](audit-log.md)) to bound **who wrote what** to the affected resource, and join its `requestId` into the function's CloudWatch group for the requests around it. Note what it cannot tell you: `AuditAction` has no `'read'` member, so reads are not recorded. Bounding *who saw* a leaked field means the log lines for the endpoint that served it, not the audit rows.
4. Fix at the chokepoint, never at the call site. A second projection in a handler is how the single-chokepoint property is lost.
5. Add the negative test for the endpoint that leaked before the fix ships — that is the "forever" in NFR-06.
