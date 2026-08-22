// TASK 2.1.2: the clinician-private field boundary — R-09, the one risk in
// docs/plan/02-risk-register.md rated **Critical**, and the second-likeliest
// way docs/plan/09-self-audit.md's red-team says this plan fails: "an
// export, a log line, an error message, a cache."
//
// docs/plan/04-data-model-rbac.md: "The clinician-private boundary is
// enforced at the repository layer — a projection function strips
// `private{}` before data can reach any patient-facing serialiser. Not in
// the handler, not in the view: one chokepoint, 100% test coverage,
// negative test per endpoint forever (NFR-06)."
//
// This file is that chokepoint, and it is built here — one phase before
// 3.2.x wires the first real entity (assessments) through it — for the same
// reason person-record.ts (TASK 0.3.4) split clinical from personal before
// any patient existed: the boundary is cheap against an empty system and
// expensive to retrofit onto a populated one.
//
// **How it is made unavoidable rather than merely available.** Two brands:
//   * `Unprojected<T>` is what every repository read hands back — a record
//     straight off the store, private half intact;
//   * `Projected<T>` is what `projectFor` returns, and the ONLY thing
//     `serialiseResponse` will accept.
// Neither brand exists at runtime; both are phantom properties. The effect
// is that "forgot to project" is a compile error at the serialiser call
// site rather than a missing test. There is no `raw` / `skipProjection`
// option and there will not be one (05-execution-plan.md TASK 2.1.2's
// "Do NOT").
//
// Note on the interface as planned: 05-execution-plan.md sketches
// `Projected<T> = T & { readonly __projected: unique symbol }`, which is not
// valid TypeScript (`unique symbol` is only legal on a `const`/`readonly
// static` declaration), and `projectFor(principal, record)` with no third
// argument. Both are adjusted below and the reasons are recorded in the
// runbook: the brand becomes a `declare const … : unique symbol` key, and
// `projectFor` takes the `Resource` because relationship — not role — is
// what `can()` needs, and a bare `T` cannot carry `ownerPatientId` /
// `assignedClinicianId` / `entityType`.
import type { Principal, Resource } from '@ndn/shared-types';

import { ASSESSMENT_ENTITY_TYPE } from './authz-matrix.js';
import { can } from './authz.js';

/**
 * The attribute name the data model gives the clinician-only half of a
 * record ("`visible{}` and `private{}` as separate attributes"). It is the
 * same string as `FieldSet`'s `'private'` member, and it is the single
 * marker every function in this file keys off — there is no allow-list of
 * "sensitive field names" to keep in sync.
 */
export const PRIVATE_FIELD_KEY = 'private';

/** What `redactPrivateText` leaves behind. Exported so tests can assert it. */
export const PRIVATE_REDACTION = '[redacted: private field]';

declare const projectedBrand: unique symbol;
declare const unprojectedBrand: unique symbol;

/**
 * A record that has been through `projectFor`. Phantom — nothing is added
 * at runtime; the property exists only so that a record which has NOT been
 * projected fails to typecheck where one is required.
 */
export type Projected<T> = T & { readonly [projectedBrand]: true };

/**
 * A record as it came off the store. Repository read (and write) methods
 * return this, so the value a handler holds is visibly the un-projected
 * one until it is passed through `projectFor`.
 */
export type Unprojected<T> = T & { readonly [unprojectedBrand]: true };

/** `Unprojected<X>` back to `X`; a plain `X` is left alone. */
type Bare<T> = Omit<T, typeof unprojectedBrand>;

/**
 * The one place the `Unprojected` brand is minted. Called by the
 * repository layer on the way out of the store — see repository.ts and
 * versioned-repository.ts. This *adds* an obligation (the value now has to
 * be projected before it can be serialised); it is not an escape hatch,
 * and branding something `Unprojected` never lets it past
 * `serialiseResponse`.
 */
export function unprojected<T>(record: T): Unprojected<T> {
  return record as Unprojected<T>;
}

/**
 * The assessment form is `authz-matrix.ts`'s one entity governed by *two*
 * matrix rows for one resource — `resolveRow` branches on `fieldSet` for
 * this entity type alone, so asking `can()` "may you read the private
 * half?" and "may you read the visible half?" are two different lookups.
 */
const ASSESSMENT_SPLIT_ENTITY_TYPES: readonly string[] = [ASSESSMENT_ENTITY_TYPE];

/**
 * TASK 3.2.1: diagnosis and care plan (`04-data-model-rbac.md`'s
 * `'Diagnosis / care plan'` row) carry a `private{}` half too, but — unlike
 * assessment — under a *single* matrix row: `'Patient (own)'` and
 * `'Sub-clinician (assigned)'`/`'Principal'` all resolve the same `read`
 * action on the same row, so `resolveRow` has nothing to branch on and
 * asking `can()` about a fabricated `fieldSet: 'private'` here would just
 * re-ask "may you read a diagnosis at all?" — answering "yes" for the
 * owning patient, exactly the leak this file exists to prevent.
 *
 * The row's own cells already draw the line the matrix can't: the patient
 * column's cell is bare `R`, never `C`/`U`, and only the two clinician
 * columns carry it — so "is this principal a clinician role" is the
 * correct, and only available, second axis. `can()` still decides whether
 * the read is allowed **at all** (an unassigned sub-clinician's `resource`
 * fails there); this function only ever narrows an already-permitted read
 * down to "with or without the private half."
 */
const ROLE_GATED_PRIVATE_ENTITY_TYPES: readonly string[] = ['diagnosis', 'care-plan'];

function mayReadPrivate(principal: Principal, resource: Resource): boolean {
  if (ASSESSMENT_SPLIT_ENTITY_TYPES.includes(resource.entityType)) {
    return can(principal, 'read', { ...resource, fieldSet: PRIVATE_FIELD_KEY }).allowed;
  }
  if (ROLE_GATED_PRIVATE_ENTITY_TYPES.includes(resource.entityType)) {
    return principal.role !== 'patient' && can(principal, 'read', resource).allowed;
  }
  // Deny by default: an entity type the data model gives no private half
  // (or one this file has not been told about) never leaks one, even to
  // the principal clinician — the same discipline authz.ts applies to an
  // unrecognised entity type.
  return false;
}

/**
 * Plain data objects only. A `Date`, an `Error`, a class instance or a
 * `Map` is a leaf: walking it would rebuild it as a bare object and
 * silently change the payload, and none of them can carry a `private{}`
 * attribute in this data model (every timestamp is stored as an ISO
 * string — 00-conventions.md).
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  // The prototype test also excludes arrays (Array.prototype), so there is
  // no separate Array.isArray branch here — both callers below peel arrays
  // off first, and an unreachable branch could not be covered by the 100%
  // condition this file is held to.
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Depth-first: every `private` key at every depth, inside arrays as well
 * as objects. Nested and array-shaped records are not a special case —
 * 3.2.x's assessment lists and any future export get the same treatment as
 * a top-level object.
 */
function stripPrivate(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripPrivate);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key !== PRIVATE_FIELD_KEY) {
      kept[key] = stripPrivate(child);
    }
  }
  return kept;
}

/**
 * The runtime half of the boundary, for the two exits where a `private`
 * key is *never* acceptable no matter who is asking: logger.ts's structured
 * line and errors.ts's message (00-conventions.md — "never log PII or
 * clinical content; log identifiers only"). The response serialiser
 * deliberately does not use this: an assigned sub-clinician is supposed to
 * receive `private{}`, and there the guarantee is the `Projected` type, not
 * a content scan.
 */
export function containsPrivateField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsPrivateField);
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.entries(value).some(
    ([key, child]) => key === PRIVATE_FIELD_KEY || containsPrivateField(child),
  );
}

/**
 * Text form of the same rule, for errors.ts. An error message is a string
 * by the time it reaches `AppError`, so a record interpolated into one
 * (`JSON.stringify(record)`, a template literal, a driver's own message)
 * cannot be walked structurally. Everything from the `private:` key onward
 * is dropped rather than brace-matched: an error message losing its tail is
 * a far cheaper failure than an error message carrying clinical notes.
 */
export function redactPrivateText(text: string): string {
  const match = /["']?private["']?\s*:/i.exec(text);
  if (match === null) {
    return text;
  }
  return `${text.slice(0, match.index)}${PRIVATE_REDACTION}`;
}

/**
 * The chokepoint. Strips every `private{}` attribute unless the matrix
 * grants this principal a read of the private half of *this* resource —
 * relationship included, which is why `resource` is a parameter and not
 * something inferred from the record.
 *
 * It answers exactly one question ("may the private half go out?"); whether
 * the principal may read the record at all is the caller's own `can()`
 * check, so a missing authorisation is never disguised as an empty
 * projection.
 */
export function projectFor<T>(
  principal: Principal,
  record: T,
  resource: Resource,
): Projected<Partial<Bare<T>>> {
  const visible = mayReadPrivate(principal, resource) ? record : stripPrivate(record);
  return visible as Projected<Partial<Bare<T>>>;
}

/** `projectFor` over a list — one decision, applied to every element. */
export function projectAllFor<T>(
  principal: Principal,
  records: readonly T[],
  resource: Resource,
): readonly Projected<Partial<Bare<T>>>[] {
  return records.map((record) => projectFor(principal, record, resource));
}

/** A JSON primitive, safe in a response body without projection. */
export type ResponseScalar = string | number | boolean | null | undefined;

/**
 * What may sit under a key of a response body: a scalar, or a record that
 * has been through `projectFor`. A raw record is not assignable — it has
 * no `projectedBrand` — which is what makes "forgot to project" a compile
 * error at the call site.
 */
export type ResponseValue = ResponseScalar | Projected<unknown> | readonly Projected<unknown>[];

/** A response envelope: `{ items }`, `{ error: 'NOT_FOUND' }`, and so on. */
export type ResponseBody = Readonly<Record<string, ResponseValue>>;

/**
 * The sanctioned way a handler turns a body into the string it returns.
 * Every Phase 2+ endpoint uses this instead of a bare `JSON.stringify` —
 * see docs/runbooks/private-field-boundary.md for the "negative test per
 * endpoint, forever" convention that comes with it (NFR-06).
 */
export function serialiseResponse(body: ResponseBody): string {
  return JSON.stringify(body);
}
