// docs/plan/04-data-model-rbac.md: "Audit event | AUDIT#<date> / <ts>#<id> |
// Append-only, who/what/when/where." AuditWriter is the interface
// Repository/VersionedRepository write through. It exposes no method that
// removes an entry, by construction.
// TASK 1.3.2: 'publish'/'unpublish' are their own actions, not folded into
// 'update' — content.status is domain-specific (draft|published|unpublished,
// packages/shared-types/src/content.ts) and doesn't go through
// Repository<T>'s active|deleted lifecycle, so the audit trail names the
// transition precisely rather than collapsing it into a generic 'update'.
// TASK 1.4.2: 'reject' is testimonial's own equivalent of 'unpublish' — a
// status transition, same discipline, named precisely for the same reason.
// TASK 1.5.1: 'cancel' is workshop's own equivalent — a workshop is never
// deleted, only ever transitioned to 'cancelled'.
// TASK 1.5.2: 'confirm' is a registration's own equivalent of 'publish' —
// a status transition fired by the Stripe webhook, not an admin. Registration
// reuses 'cancel' rather than adding a distinct verb: same status name
// (Registration.status is also 'cancelled'), same meaning (never deleted).
//
// TASK 2.1.3 makes three changes to this file, and each closes a gap this
// header used to describe as temporary.
//
//  1. **The log is durable.** The sentence that stood here — "InMemoryAuditLog
//     is today's implementation (no DynamoDB table exists yet)" — stopped
//     being true when NdnDataStack shipped at TASK 1.3.1, and nothing came
//     back for it: every create, update, soft-delete, publish, unpublish,
//     reject, cancel and confirm the platform has performed was appended to
//     an array in a Lambda's memory and discarded when the invocation ended.
//     `DynamoAuditLog` (dynamo-audit-log.ts) is what every production
//     handler wires now. `InMemoryAuditLog` survives as a test double only,
//     and audit-wiring.test.ts fails the build if a production handler
//     imports it again.
//  2. **"Who" is a principal, not a bare string.** An audit row now carries
//     the actor's role alongside its subject id, so a reviewer reading a
//     day's events can tell a clinician's action from a visitor's without
//     resolving every identifier.
//  3. **"Where" exists at all.** The data model has asked for who/what/
//     when/*where* since the plan was committed; the type only ever carried
//     the first three. `requestId` and `sourceIpHash` come off the API
//     Gateway event.
import { createHash } from 'node:crypto';

import type { Principal, Role } from '@ndn/shared-types';

/**
 * The closed vocabulary, as a value rather than only a type, so the tests
 * that have to cover *every* action (dynamo-audit-log.test.ts's round-trip)
 * iterate it instead of restating it and drifting. `AuditAction` is derived
 * from it, so adding a verb here is the only edit needed.
 */
export const AUDIT_ACTIONS = [
  'create',
  'update',
  'soft-delete',
  'publish',
  'unpublish',
  'reject',
  'cancel',
  'confirm',
  // TASK 4.2.1: the first *read-shaped* actions this union carries. A
  // call join is closer to "did this consultation happen" than to an
  // ordinary read — private-field-boundary.md's own "reads are not
  // recorded" note holds everywhere else; this is the one deliberate,
  // narrow exception to it, stated here rather than left as a silent
  // contradiction. Both the allow and the deny outcome are recorded —
  // 'join' is the only entry in this list whose own name is not itself
  // the state transition performed on a record (nothing about the
  // connection or appointment row changes on a denial), because "an
  // attempt was made and refused" is the fact worth keeping.
  'join',
  'join-denied',
  // D-29 (2026-08-29): a principal issuing a patient a new Cognito
  // password. Recorded under its own name rather than folded into
  // 'update': nothing about the `PAT#` record changes when this happens —
  // only the directory does — so there is no repository write for a
  // generic 'update' row to attach to. `patient-admin.ts` writes this
  // event directly through the same `AuditWriter` every repository uses.
  // A credential handout is exactly the kind of act a reviewer most needs
  // this log to be able to answer "who, and when" about.
  'reset-password',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * docs/plan/05-execution-plan.md TASK 2.1.3 types this field as `Role`.
 * Widened by two members, because Phase 1 shipped before there was an
 * identity system and its actors are still writing audit rows:
 *
 *   * `'public'` — an unauthenticated visitor (testimonial submission,
 *     workshop checkout). Their subject id is a hash of their source
 *     address, which is the only identifier they have.
 *   * `'system'` — a machine actor with no human behind it, i.e. the
 *     Stripe webhook confirming or cancelling a registration.
 *
 * A third member, `'admin-token'`, stood here until TASK 2.5.4: the bearer
 * gate admin-auth.ts called "one narrow, explicitly-temporary … not a real
 * auth system: no user identity, no session, no scopes," which content
 * authoring, workshop authoring and testimonial moderation all acted as.
 * Retired along with the gate — no code path can construct one any more —
 * but historical audit rows written under it are real, permanent data
 * (append-only, never amended, never expired) that this type no longer
 * describes. Nothing here validates a row read back from storage against
 * this union (dynamo-audit-log.ts trusts the read), so an old row with
 * `actorRole: 'admin-token'` still reads back exactly as written; only new
 * code is narrower now.
 *
 * Recording these honestly is the point. Mapping them onto a real `Role`
 * would put a clinician's role on a row a clinician had nothing to do
 * with, which is worse than a union with named exceptions in it — and an
 * audit log that misattributes is worse than one that admits it does not
 * know.
 */
export type AuditActorRole = Role | 'public' | 'system';

/**
 * Who is acting, and where from — everything an audit row needs beyond the
 * what and the when. This is what repository methods take in place of the
 * bare `actor: string` they used to, so supplying the "where" is a compile
 * obligation at every write site rather than something a handler can
 * forget. Nothing personal or clinical belongs on it: identifiers only
 * (docs/plan/00-conventions.md).
 */
export interface ActorContext {
  /** The Cognito `sub` once TASK 2.2.x lands; a hashed address or a named machine actor until then. */
  readonly subjectId: string;
  readonly role: AuditActorRole;
  /** API Gateway's own request id — the join key between an audit row and a CloudWatch log line. */
  readonly requestId: string;
  /** SHA-256 of the caller's source address. Never the address itself — see `hashSourceIp`. */
  readonly sourceIpHash: string;
}

/** The two things a handler pulls off its API Gateway event to build an `ActorContext`. */
export interface RequestOrigin {
  readonly requestId: string;
  readonly sourceIp: string;
}

/**
 * The audit trail's "where", one-way. contact-form-handler.ts,
 * testimonial-submission-handler.ts and stripe-checkout-handler.ts each
 * hashed the source address with their own copy of this function ("never
 * the raw address itself, never logged"); TASK 2.1.3 needs the same value
 * in six more places, so the convention lives here once.
 *
 * **This is the one deliberate deviation from TASK 2.1.3's stated
 * interface, which names the field `sourceIp`.** An IP address is personal
 * data under UK GDPR, and an audit row is the one row in this system that
 * is appended once, never amended, never expired (step 6: no TTL) and
 * never deleted (C-03). Putting a raw address in it would create exactly
 * the erasure tension docs/plan/02-risk-register.md's R-04 leaves open for
 * the DPO, in the one place where the plan's own answer to erasure is "we
 * cannot." A hash still answers what an audit trail asks of an address —
 * *was this the same origin as that?* — which is why the three Phase 1
 * handlers already stored it this way.
 */
export function hashSourceIp(sourceIp: string): string {
  return createHash('sha256').update(sourceIp).digest('hex');
}

/**
 * The two fields off an API Gateway v2 event, named structurally rather
 * than by importing `APIGatewayProxyEventV2` — this file sits under the
 * repository layer and stays free of the Lambda types, the same way it
 * stays free of the AWS SDK.
 */
export function requestOriginOf(event: {
  readonly requestContext: {
    readonly requestId: string;
    readonly http: { readonly sourceIp: string };
  };
}): RequestOrigin {
  return {
    requestId: event.requestContext.requestId,
    sourceIp: event.requestContext.http.sourceIp,
  };
}

/** Builds an `ActorContext` from an actor's identity plus the request it arrived on. */
export function actorContext(
  who: { readonly subjectId: string; readonly role: AuditActorRole },
  origin: RequestOrigin,
): ActorContext {
  return {
    subjectId: who.subjectId,
    role: who.role,
    requestId: origin.requestId,
    sourceIpHash: hashSourceIp(origin.sourceIp),
  };
}

/**
 * The Phase 2+ path: an authenticated caller's `Principal` (TASK 2.1.1) is
 * already exactly the "who" an audit row wants, so no handler has to
 * restate it. `Role` is a subset of `AuditActorRole`, so this never widens
 * anything.
 */
export function actorFromPrincipal(principal: Principal, origin: RequestOrigin): ActorContext {
  return actorContext({ subjectId: principal.subjectId, role: principal.role }, origin);
}

export interface AuditEvent {
  readonly at: string;
  /** The actor's subject id, not a name (docs/plan/00-conventions.md: "log identifiers only"). */
  readonly actor: string;
  readonly actorRole: AuditActorRole;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
  readonly requestId: string;
  readonly sourceIpHash: string;
}

/** What the repository layer knows about an event by itself: the what and the when. */
export interface AuditEventFacts {
  readonly at: string;
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId: string;
}

/**
 * The one place an `ActorContext` becomes the who/where half of a row.
 * Every repository builds its events through this rather than spreading
 * the actor's fields itself, so the mapping is stated once and a future
 * field lands in one place.
 */
export function auditEventFor(actor: ActorContext, facts: AuditEventFacts): AuditEvent {
  return {
    at: facts.at,
    actor: actor.subjectId,
    actorRole: actor.role,
    action: facts.action,
    entityType: facts.entityType,
    entityId: facts.entityId,
    requestId: actor.requestId,
    sourceIpHash: actor.sourceIpHash,
  };
}

export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
}

/**
 * The read side, deliberately a separate interface from `AuditWriter` and
 * never implemented by the same object a repository holds: TASK 2.1.3 step
 * 4 grants the writer `dynamodb:PutItem` and nothing else, "so a
 * compromised writer cannot read the log it appends to." The type mirrors
 * that split — a repository is handed something that can only append.
 *
 * One day per call, because the partition is one day
 * (docs/plan/04-data-model-rbac.md's `AUDIT#<date>`).
 */
export interface AuditReader {
  listByDate(date: string): Promise<readonly AuditEvent[]>;
}

/**
 * **Test double.** Production wiring uses `DynamoAuditLog`
 * (dynamo-audit-log.ts) — audit-wiring.test.ts asserts that no handler
 * imports this class, which is the same shape of assertion Gate G1 §3a's
 * fix needed for `InMemoryFlagSource`: a seam that was correctly deferred
 * and then quietly stayed the production implementation for five
 * milestones. Kept because repository tests need a writer they can read
 * back, and for no other reason.
 */
export class InMemoryAuditLog implements AuditWriter {
  private readonly events: AuditEvent[] = [];

  async write(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  list(): readonly AuditEvent[] {
    return [...this.events];
  }
}
