// TASK 2.2.2: the decision itself, SDK-free and unit-testable — the same
// split every other endpoint in this service uses. authorizer-handler.ts is
// the only place the real Cognito verifier and the real DynamoDB directory
// are wired.
//
// Everything downstream trusts the `Principal` this produces, so the rules
// it follows are stated as invariants rather than left in the code:
//
//   1. The role comes from *which pool's keys verified the signature*
//      (jwt-verify.ts), never from a claim. The one thing a claim decides
//      is principal-clinician versus sub-clinician, and `cognito:groups`
//      is settable only by an admin API call, never by the token holder.
//   2. Account status is read from the record, once, and travels on the
//      Principal — so a suspended patient stops working within the
//      authorizer cache window rather than at their next sign-in.
//   3. Every failure denies. There is no path through this function that
//      returns `isAuthorized: true` without a verified token *and* a
//      resolved record.
import type { AccountStatus, Principal, Role } from '@ndn/shared-types';

import { extractBearerToken, type TokenPool, type TokenVerifier } from './jwt-verify.js';

/** The `cognito:groups` membership that distinguishes the two clinician roles. */
export const PRINCIPAL_CLINICIAN_GROUP = 'principal-clinician';

/**
 * What the authorizer knows about a subject after looking it up. Not the
 * record — the two fields an authorisation decision needs from it.
 *
 * `recordId` is the `PAT#<id>`/`CLI#<id>` identifier that becomes the
 * Principal's `patientId`/`clinicianId`, which is what `can()` compares
 * against a resource's `ownerPatientId`/`assignedClinicianId`.
 */
export interface DirectoryEntry {
  readonly recordId: string;
  readonly accountStatus: AccountStatus;
}

export interface PrincipalDirectory {
  /**
   * `undefined` means "no record for this subject", which is a denial and
   * not an error. It is also the *normal* answer until TASK 2.2.3 creates
   * the first patient profile — see authorizer-handler.ts.
   */
  lookup(pool: TokenPool, subjectId: string): Promise<DirectoryEntry | undefined>;
}

export type DenyReason =
  | 'no-bearer-token'
  | 'token-not-verified'
  | 'no-directory-record'
  | 'lookup-failed'
  // TASK 4.1.1: the WebSocket authorizer's own reason — no route exists
  // to read a flag downstream of a connect, so ws-authorizer.ts checks it
  // here instead of at a handler. Never produced by the HTTP authorizer.
  | 'flag-disabled';

/** Identifiers only. Never a token, never a claim body, never an email address. */
export interface AuthorizerDecisionLog {
  readonly route: string;
  readonly allowed: boolean;
  readonly reason?: DenyReason;
  readonly subjectId?: string;
  readonly pool?: TokenPool;
  readonly role?: Role;
}

export interface AuthorizerDeps {
  readonly verifier: TokenVerifier;
  readonly directory: PrincipalDirectory;
  /** Injectable sink — defaults to stdout, the same convention logger.ts uses. */
  readonly log?: (decision: AuthorizerDecisionLog) => void;
}

/**
 * API Gateway's simple-response shape for payload format 2.0. `context` is
 * what reaches a handler as `event.requestContext.authorizer.lambda`, and
 * request-principal.ts is the only thing that reads it.
 */
export interface AuthorizerResult {
  readonly isAuthorized: boolean;
  readonly context: Record<string, string>;
}

const DENY: AuthorizerResult = { isAuthorized: false, context: {} };

function roleFor(pool: TokenPool, groups: readonly string[]): Role {
  if (pool === 'patient') {
    // A patient-pool token is a patient even if its groups claim says
    // otherwise. This is the case the "a `cognito:groups` claim asserting
    // principal-clinician on a patient-pool token" test covers, and the
    // reason the two directories exist at all.
    return 'patient';
  }
  return groups.includes(PRINCIPAL_CLINICIAN_GROUP) ? 'principal-clinician' : 'sub-clinician';
}

/**
 * Flat strings only, exported for ws-authorizer.ts's identical need — a
 * WebSocket authorizer's `context` map reaches its own $connect handler the
 * same way this one reaches an HTTP handler (`event.requestContext.authorizer`),
 * and both are built from the same `Principal`.
 */
export function principalContext(principal: Principal): Record<string, string> {
  // Flat strings only. API Gateway will carry richer JSON, but every value
  // arrives at the handler as data that has to be re-validated anyway
  // (request-principal.ts), and a flat shape is one that cannot smuggle a
  // nested object nobody checked.
  const context: Record<string, string> = {
    subjectId: principal.subjectId,
    role: principal.role,
    accountStatus: principal.accountStatus,
  };
  if (principal.patientId) context.patientId = principal.patientId;
  if (principal.clinicianId) context.clinicianId = principal.clinicianId;
  return context;
}

export interface AuthorizerEvent {
  readonly headers?: Record<string, string | undefined>;
  readonly routeKey?: string;
}

/** What {@link resolvePrincipal} produces on success — the `Principal` plus which pool minted its token, since callers log the pool alongside the role. */
export interface PrincipalResolution {
  readonly principal: Principal;
  readonly pool: TokenPool;
}

/**
 * The verify → look-up → role-resolve pipeline, shared by the HTTP
 * authorizer below and ws-authorizer.ts's WebSocket-shaped twin (TASK
 * 4.1.1) — everything both have in common: a bearer token in, a `Principal`
 * or a logged denial out. What differs between the two callers is only the
 * event shape a token is read from and the response shape a decision is
 * wrapped in, neither of which this function knows about.
 *
 * `deny` is a callback rather than a return value so each caller can shape
 * its own refusal (the HTTP authorizer's `{isAuthorized: false}`, the
 * WebSocket authorizer's IAM policy) without this function taking a stance
 * on either.
 */
export async function resolvePrincipal(
  deps: Pick<AuthorizerDeps, 'verifier' | 'directory'>,
  token: string | undefined,
  deny: (reason: DenyReason, extra?: Partial<AuthorizerDecisionLog>) => void,
): Promise<PrincipalResolution | undefined> {
  if (!token) {
    deny('no-bearer-token');
    return undefined;
  }

  const verified = await deps.verifier.verify(token);
  if (!verified) {
    // Deliberately no subjectId: an unverified token's `sub` is a string
    // the caller chose, and logging it would put attacker-controlled
    // data in the audit trail dressed as an identity.
    deny('token-not-verified');
    return undefined;
  }

  const role = roleFor(verified.pool, verified.groups);

  let entry: DirectoryEntry | undefined;
  try {
    entry = await deps.directory.lookup(verified.pool, verified.subjectId);
  } catch {
    // The single most important line in this file. A table that will not
    // answer is not permission to proceed — an internal failure is a
    // denial, and the caller gets a 403 rather than an allow with an
    // unresolved account status.
    deny('lookup-failed', { subjectId: verified.subjectId, pool: verified.pool, role });
    return undefined;
  }

  if (!entry) {
    deny('no-directory-record', { subjectId: verified.subjectId, pool: verified.pool, role });
    return undefined;
  }

  const principal: Principal =
    role === 'patient'
      ? {
          subjectId: verified.subjectId,
          role,
          accountStatus: entry.accountStatus,
          patientId: entry.recordId,
        }
      : {
          subjectId: verified.subjectId,
          role,
          accountStatus: entry.accountStatus,
          clinicianId: entry.recordId,
        };

  return { principal, pool: verified.pool };
}

export function createAuthorizer(
  deps: AuthorizerDeps,
): (event: AuthorizerEvent) => Promise<AuthorizerResult> {
  const log = deps.log ?? ((decision) => process.stdout.write(`${JSON.stringify(decision)}\n`));

  return async (event) => {
    // `$request.header.Authorization` is the identity source, and API
    // Gateway lowercases header names in the v2 payload. Both spellings
    // are read because a v1-shaped test fixture is the likeliest way this
    // silently stops matching.
    const route = event.routeKey ?? 'unknown';
    const header = event.headers?.authorization ?? event.headers?.Authorization;

    const deny = (reason: DenyReason, extra: Partial<AuthorizerDecisionLog> = {}) => {
      log({ route, allowed: false, reason, ...extra });
    };

    const token = extractBearerToken(header);
    const resolution = await resolvePrincipal(deps, token, deny);
    if (!resolution) {
      return DENY;
    }
    const { principal } = resolution;

    // Note what is *not* decided here: whether the status permits the
    // action. `can()` (authz.ts) owns that, and it gates a non-operative
    // status down to reading one's own profile rather than to nothing — a
    // declined or suspended patient can still see their own account. An
    // authorizer that denied on status would take that away and would put
    // a second copy of the policy on the request path.
    log({
      route,
      allowed: true,
      subjectId: principal.subjectId,
      pool: resolution.pool,
      role: principal.role,
    });
    return { isAuthorized: true, context: principalContext(principal) };
  };
}
