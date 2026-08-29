// TASK 2.4.1: `POST /clinicians`, `POST /clinicians/{id}/deactivate`,
// `POST /clinicians/{id}/reactivate` — SDK-free and unit-testable, the
// same split every other authoring endpoint uses (content-authoring.ts /
// clinician-admin-handler.ts wires the real AWS clients).
//
// **The first production route to use the real Lambda authorizer**
// (request-principal.ts's `requirePrincipal`) rather than the admin-token
// bridge every other admin-shaped route still stands behind until TASK
// 2.5.4 retires it. This route never used the bridge to begin with: its
// entire subject is clinician *identity*, and a real clinician principal
// has existed to authenticate as since 2.2.1/2.2.2 landed — gating it with
// a shared secret that carries no identity would make its own audit rows
// say `admin-token` for exactly the operation whose audit trail most needs
// to say *which* clinician acted.
//
// **Invite email: Cognito's own, not the Notifier — a deliberate deviation
// from this task's step 8.** `AdminCreateUser`'s built-in invite is the
// only thing that ever knows the temporary password; routing it through
// `Notifier.send` would mean generating that secret ourselves and putting
// it in a plain-text SES relay this codebase does not otherwise treat as
// credential-safe, in place of Cognito's own security-reviewed delivery
// path (the same mechanism `SignUp`'s email-OTP flow already trusts).
// **Deactivation notice does go through the Notifier**, per step 8 — no
// credential involved, and it is exactly the kind of "closes the loop"
// message the abstraction exists for.
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import type { ClinicianRepository } from './clinician-repository.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { Notifier } from './notifications.js';
import { requirePrincipal } from './request-principal.js';

const CLINICIAN_ADMIN_FLAG = 'clinicians.administration.enabled';
const CLINICIAN_RESOURCE = { entityType: 'clinician-account' } as const;

// Every request, unsampled — the lowest-volume admin surface in the
// estate (one principal, acting rarely) and the one whose own access a
// reviewer is most likely to want to reconstruct later, same reasoning
// audit-read.ts states for its own sample rate.
const CLINICIAN_ADMIN_LOG_SAMPLE_RATE = 1;

const createClinicianBodySchema = z.object({
  email: z.string().email().max(254),
  displayName: z.string().min(1).max(200),
  role: z.enum(['principal', 'sub']),
});

/**
 * The Cognito call, as a port — same shape patient-admin.ts's
 * `AdminCreatePatientPort` takes, for the same reason: keeping AWS behind
 * an interface is what lets every test below run without it. Returns the
 * `sub` `AdminCreateUser` minted, so the caller can write `CLI#<sub>` —
 * see clinician-repository.ts's header for why this ordering, not the
 * reverse the task text states.
 */
export interface AdminCreateClinicianPort {
  createUser(email: string): Promise<string>;
  /**
   * Found missing live, 2026-08-28: nothing in this codebase ever called
   * `AdminAddUserToGroup`, so `authorizer.ts`'s `roleFor()` — which reads
   * `cognito:groups`, never the `CLI#` record's own `role` field — could
   * never resolve anyone to `principal-clinician`, no matter what the
   * DynamoDB record said. Called only when `role === 'principal'`, after
   * `repository.create()` has actually accepted the row (never before —
   * a rejected `PRINCIPAL_ALREADY_EXISTS` create must not have already
   * granted the group).
   */
  addToPrincipalGroup(subjectId: string): Promise<void>;
}

/** Both calls step 4 requires, as one port — deactivation is never "just" the disable. */
export interface AdminDeactivateClinicianPort {
  disable(subjectId: string): Promise<void>;
  revokeTokens(subjectId: string): Promise<void>;
  /** Best-effort only — see this file's header on the deactivation notice. Undefined if it can't be resolved. */
  getEmail(subjectId: string): Promise<string | undefined>;
}

export interface AdminReactivateClinicianPort {
  enable(subjectId: string): Promise<void>;
}

export interface ClinicianAdminDeps {
  readonly repository: ClinicianRepository;
  readonly flags: FlagReader;
  readonly createClinicianUser: AdminCreateClinicianPort;
  readonly deactivateClinicianUser: AdminDeactivateClinicianPort;
  readonly reactivateClinicianUser: AdminReactivateClinicianPort;
  readonly notifier: Notifier;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
  readonly log?: (line: Record<string, unknown>) => void;
}

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function createClinicianAdminHandler(
  deps: ClinicianAdminDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: CLINICIAN_ADMIN_LOG_SAMPLE_RATE });
  const log = deps.log ?? ((line) => process.stdout.write(`${JSON.stringify(line)}\n`));

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

    const respond = (statusCode: number, body: unknown) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      };
    };

    // Default off, and off means "this route does not exist" — same
    // convention every other flag-gated endpoint follows.
    if (!(await deps.flags.isEnabled(CLINICIAN_ADMIN_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    try {
      switch (routeKey) {
        case 'POST /clinicians': {
          if (!can(principal, 'create', CLINICIAN_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const parsed = createClinicianBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          // TASK 2.2.2 having no `cognito-idp` grant does not apply here —
          // unlike `SignUp`, `AdminCreateUser` is an authenticated,
          // IAM-authorised operation; clinician-admin-handler.ts's role
          // carries exactly the five Admin* grants this file's ports use
          // (AdminAddUserToGroup joined the other four 2026-08-28 — see
          // AdminCreateClinicianPort's own header).
          const subjectId = await deps.createClinicianUser.createUser(parsed.data.email);
          const clinician = await deps.repository.create(
            subjectId,
            { displayName: parsed.data.displayName, role: parsed.data.role },
            actor,
          );
          if (clinician.role === 'principal') {
            await deps.createClinicianUser.addToPrincipalGroup(subjectId);
          }
          return respond(201, { item: clinician });
        }
        case 'POST /clinicians/{id}/deactivate': {
          if (!can(principal, 'update', CLINICIAN_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const clinician = await deps.repository.deactivate(id, actor);
          // Record first, Cognito second (this file's header): `can()`
          // already re-resolves `account_status` fresh within the
          // authorizer's 5-minute cache window regardless of what happens
          // below, so the record change is the change that matters most —
          // these two calls close the remaining gap and are not caught: a
          // half-completed deactivation (record changed, session still
          // live) must surface loudly, not be swallowed as a success.
          await deps.deactivateClinicianUser.disable(id);
          await deps.deactivateClinicianUser.revokeTokens(id);
          try {
            const email = await deps.deactivateClinicianUser.getEmail(id);
            if (email) {
              await deps.notifier.send({ id, email }, 'clinicianDeactivated', {});
            }
          } catch {
            // Best-effort, same posture post-confirmation.ts takes on its
            // own confirmation email: the deactivation is already real and
            // already audited: a notice that fails to send must not undo
            // either.
            log({ event: 'clinician-deactivated-email-failed', subjectId: id });
          }
          return respond(200, { item: clinician });
        }
        case 'POST /clinicians/{id}/reactivate': {
          if (!can(principal, 'update', CLINICIAN_RESOURCE).allowed) {
            return respond(403, { error: 'FORBIDDEN' });
          }
          const id = event.pathParameters?.id;
          if (!id) {
            return respond(400, { error: 'ID_REQUIRED' });
          }
          const clinician = await deps.repository.reactivate(id, actor);
          await deps.reactivateClinicianUser.enable(id);
          return respond(200, { item: clinician });
        }
        default:
          return respond(404, { error: 'NOT_FOUND' });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
        return respond(404, { error: error.code });
      }
      if (error instanceof AppError && error.code === 'PRINCIPAL_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      if (error instanceof AppError && error.code === 'RECORD_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
