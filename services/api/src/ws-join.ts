// TASK 4.2.1: the join decision itself, SDK-free and unit-testable — the
// same split every other business-logic file in this service uses.
// ws-join-handler.ts is the only place the real stores are wired.
//
// TASK 4.1.1 proves who is on a socket; nothing until now has asked "is
// this appointment — the call's own reason to exist — the one this
// principal may join, right now." `can()` (authz.ts) governs that first
// question — a stricter claim than `'read'` on the same `Appointments`
// row, `04-data-model-rbac.md`'s own note on that row states why it is
// narrower. The two checks the matrix cannot express — the record's own
// live status, and a named window around `scheduledAt` — are this file's
// own job.
import type { AccountStatus, Appointment, Principal, Role } from '@ndn/shared-types';

import { APPOINTMENT_ENTITY_TYPE } from './appointment-repository.js';
import { auditEventFor, type ActorContext, type AuditWriter } from './audit.js';
import { can } from './authz.js';
import type { Clock } from './clock.js';
import type { FlagName, FlagReader } from './flags.js';
import type { TokenPool } from './jwt-verify.js';
import type { Unprojected } from './projection.js';

/**
 * Opens this many minutes before `scheduledAt` — late enough that a caller
 * cannot reuse a link days early, early enough that a caller who arrives
 * promptly for a call is never refused. Named here rather than left as a
 * magic number (the task's own instruction) — `docs/runbooks/video-signalling.md`
 * states the same two figures.
 */
export const JOIN_WINDOW_OPENS_BEFORE_MINUTES = 10;
/** Closes this many minutes after `scheduledAt` — sized so a late-running clinician can still join, short enough that a stale link cannot be reused days later. */
export const JOIN_WINDOW_CLOSES_AFTER_MINUTES = 30;

const CALL_AUTHZ_FLAG: FlagName = 'video.callAuthz.enabled';

export type JoinDenialReason =
  | 'too-early'
  | 'too-late'
  | 'cancelled'
  // 2026-09-01. Before the approval step there was one non-`scheduled`
  // state a live appointment could be in, so `'cancelled'` covered every
  // status check here honestly. It no longer does: a booking waiting on
  // the principal is not cancelled, it is not yet an appointment, and
  // telling its own clinician it was cancelled would send them looking for
  // a cancellation nobody made. Denied either way — this is about the
  // sentence the person reads, not about the boundary.
  | 'not-confirmed'
  | 'not-your-appointment'
  // Not one of the plan's own four named reasons — the plan's own text
  // never considered the flag being off as a state a live join attempt
  // could reach, but "the feature is not turned on" is a real outcome
  // that deserves its own honest reason, the same "a denial carries a
  // reason, never a bare close" discipline the other four exist to serve.
  | 'not-available';

export type JoinResult =
  | { readonly type: 'joined' }
  | { readonly type: 'join-denied'; readonly reason: JoinDenialReason };

/** What `ws-join-handler.ts` already knows about the caller's connection before calling in here — `connection-repository.ts`'s own `Connection` row, minus the fields this decision has no use for. */
export interface JoinCallerConnection {
  readonly principalId: string;
  readonly role: Role;
  readonly ttl: number;
}

/** The one-`GetItem` lookup `authorizer.ts`'s own `resolvePrincipal` already performs — reused here by shape, not by import: this file stays free of `jwt-verify.ts`'s `TokenVerifier`, which a caller already authenticated at $connect has no further use for. */
export interface JoinPrincipalDirectory {
  lookup(
    pool: TokenPool,
    subjectId: string,
  ): Promise<{ recordId: string; accountStatus: AccountStatus } | undefined>;
}

export interface JoinAppointmentReader {
  get(patientId: string, scheduledAt: string): Promise<Unprojected<Appointment> | undefined>;
}

export interface RecordCallJoin {
  readonly appointmentId: string;
  readonly connectionId: string;
  readonly principalId: string;
  readonly role: Role;
  readonly ttl: number;
}

export interface JoinCallRecorder {
  recordCallJoin(input: RecordCallJoin): Promise<void>;
}

export interface JoinMessageDeps {
  readonly directory: JoinPrincipalDirectory;
  readonly appointments: JoinAppointmentReader;
  readonly connections: JoinCallRecorder;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly flags: FlagReader;
}

export interface JoinMessageInput {
  readonly connectionId: string;
  readonly connection: JoinCallerConnection;
  readonly appointmentId: string;
  readonly origin: { readonly requestId: string; readonly sourceIpHash: string };
}

function poolFor(role: Role): TokenPool {
  return role === 'patient' ? 'patient' : 'clinician';
}

/** The identical construction `authorizer.ts`'s own `resolvePrincipal` performs, over an already-known identity rather than a freshly-verified token. */
function principalFrom(
  connection: JoinCallerConnection,
  entry: { recordId: string; accountStatus: AccountStatus },
): Principal {
  return connection.role === 'patient'
    ? {
        subjectId: connection.principalId,
        role: 'patient',
        accountStatus: entry.accountStatus,
        patientId: entry.recordId,
      }
    : {
        subjectId: connection.principalId,
        role: connection.role,
        accountStatus: entry.accountStatus,
        clinicianId: entry.recordId,
      };
}

/**
 * `<patientId>#<scheduledAt>` — `appointment-repository.ts`'s own header:
 * "an appointment has no natural single opaque id." Undefined for
 * anything that does not split into exactly two non-empty parts, which
 * denies rather than guesses at a malformed id.
 */
function parseAppointmentId(
  appointmentId: string,
): { patientId: string; scheduledAt: string } | undefined {
  const separator = appointmentId.indexOf('#');
  if (separator <= 0 || separator === appointmentId.length - 1) {
    return undefined;
  }
  return {
    patientId: appointmentId.slice(0, separator),
    scheduledAt: appointmentId.slice(separator + 1),
  };
}

function windowMiss(scheduledAt: string, now: Date): 'too-early' | 'too-late' | undefined {
  const scheduledMs = new Date(scheduledAt).getTime();
  const opensAtMs = scheduledMs - JOIN_WINDOW_OPENS_BEFORE_MINUTES * 60_000;
  const closesAtMs = scheduledMs + JOIN_WINDOW_CLOSES_AFTER_MINUTES * 60_000;
  const nowMs = now.getTime();
  if (nowMs < opensAtMs) return 'too-early';
  if (nowMs > closesAtMs) return 'too-late';
  return undefined;
}

export function createJoinMessageHandler(
  deps: JoinMessageDeps,
): (input: JoinMessageInput) => Promise<JoinResult> {
  return async (input) => {
    const now = deps.clock.now();

    if (!(await deps.flags.isEnabled(CALL_AUTHZ_FLAG))) {
      // No audit write here, unlike every denial below: an audit event
      // names a principal acting against a resource (auditEventFor's own
      // shape), and "the feature is off" is an operational fact rather
      // than an access decision about this caller — the identical "a
      // flag-gated route 404s before any business logic runs, audit
      // included" shape every HTTP route in this codebase already keeps.
      return { type: 'join-denied', reason: 'not-available' };
    }

    const actor: ActorContext = {
      subjectId: input.connection.principalId,
      role: input.connection.role,
      requestId: input.origin.requestId,
      sourceIpHash: input.origin.sourceIpHash,
    };

    const deny = async (reason: JoinDenialReason): Promise<JoinResult> => {
      await deps.audit.write(
        auditEventFor(actor, {
          at: now.toISOString(),
          action: 'join-denied',
          entityType: APPOINTMENT_ENTITY_TYPE,
          entityId: input.appointmentId,
        }),
      );
      return { type: 'join-denied', reason };
    };

    const parsed = parseAppointmentId(input.appointmentId);
    if (!parsed) {
      return deny('not-your-appointment');
    }

    const appointment = await deps.appointments.get(parsed.patientId, parsed.scheduledAt);
    if (!appointment) {
      // Cannot leak whether an appointment id exists — the same
      // deny-by-default reading a wrong id and a real-but-unowned one
      // both get.
      return deny('not-your-appointment');
    }

    const entry = await deps.directory.lookup(
      poolFor(input.connection.role),
      input.connection.principalId,
    );
    if (!entry) {
      return deny('not-your-appointment');
    }

    const principal = principalFrom(input.connection, entry);
    const decision = can(principal, 'join-call', {
      entityType: APPOINTMENT_ENTITY_TYPE,
      ownerPatientId: appointment.patientId,
      assignedClinicianId: appointment.clinicianId,
    });
    // Every can() denial reason (unknown-role, malformed-principal,
    // account-not-active, matrix-denies) folds into the one authorisation-
    // layer reason the caller ever sees — 'not-your-appointment' is
    // deliberately the catch-all here, distinct from the two
    // appointment-state reasons below that are only ever reached once
    // authorisation has already passed.
    if (!decision.allowed) {
      return deny('not-your-appointment');
    }

    if (appointment.appointment_status === 'pending-approval') {
      return deny('not-confirmed');
    }
    if (appointment.appointment_status !== 'scheduled') {
      return deny('cancelled');
    }

    const miss = windowMiss(appointment.scheduledAt, now);
    if (miss) {
      return deny(miss);
    }

    await deps.connections.recordCallJoin({
      appointmentId: input.appointmentId,
      connectionId: input.connectionId,
      principalId: input.connection.principalId,
      role: input.connection.role,
      ttl: input.connection.ttl,
    });
    await deps.audit.write(
      auditEventFor(actor, {
        at: now.toISOString(),
        action: 'join',
        entityType: APPOINTMENT_ENTITY_TYPE,
        entityId: input.appointmentId,
      }),
    );
    return { type: 'joined' };
  };
}
