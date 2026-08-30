// TASK 2.5.1: `POST /patients/{id}/approve`, `POST /patients/{id}/decline`
// — SDK-free and unit-testable, the same split every other endpoint uses
// (assignment-handler.ts wires the real DynamoDB-backed store and the
// real Lambda authorizer's principal). TASK 2.5.2 adds
// `POST /patients/{id}/reassign`, same body shape, same route family.
//
// Only the `Principal` column ever passes `can()` on `'Patient assignment'`
// (authz-matrix.ts) — a sub-clinician is denied even onto themselves (see
// that file's own comment on the row). So this handler checks `can()`
// once per route and trusts the matrix's own verdict completely; it does
// not re-derive "only the principal" as a second, redundant check.
//
// D-32 (2026-08-30): step 6's own notification side-effect (patient
// approve/decline/reassign notices, clinician caseload add/remove
// notices) is deleted, not darkened — the owner's own words, "any
// notification will go via whatsapp." The decision itself, its audit
// row, and every state transition below are entirely unchanged; only
// the "then tell someone by email/SMS" step is gone. See
// docs/runbooks/patient-assignment.md.
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import type { AssignmentRepository } from './assignment-repository.js';
import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { requirePrincipal } from './request-principal.js';

const ASSIGNMENT_FLAG = 'assignment.enabled';
const ASSIGNMENT_RESOURCE = { entityType: 'patient-assignment' } as const;

// Shared by /approve and /reassign — both name the clinician the patient
// is being assigned to, and nothing else. There is deliberately no way to
// submit a request with this field absent or empty: step 6's "there is no
// unassign" is enforced by this schema having no shape that omits it, not
// by a runtime check.
const assignedClinicianBodySchema = z.object({ assignedClinicianId: z.string().min(1) });

export interface AssignmentDeps {
  readonly repository: AssignmentRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
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

export function createAssignmentHandler(
  deps: AssignmentDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createSampledLogger({ clock, sampleRate: 1 });

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

    // Off means "this route does not exist" — turned on together with
    // patients.administration.enabled (D-29), per this task's own Flag
    // line: creating an account into a system with no route out of
    // `pending` strands people there.
    if (!(await deps.flags.isEnabled(ASSIGNMENT_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    // Checked before the id or the body — a caller the matrix denies must
    // not be able to tell a well-formed request from a malformed one by
    // the shape of the refusal (same rule audit-read.ts states).
    if (!can(principal, 'create', ASSIGNMENT_RESOURCE).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }

    const id = event.pathParameters?.id;
    if (!id) {
      return respond(400, { error: 'ID_REQUIRED' });
    }

    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    try {
      switch (routeKey) {
        case 'POST /patients/{id}/approve': {
          const parsed = assignedClinicianBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          const decision = await deps.repository.approve(
            id,
            parsed.data.assignedClinicianId,
            actor,
          );
          return respond(200, { item: decision.request });
        }
        case 'POST /patients/{id}/decline': {
          const decision = await deps.repository.decline(id, actor);
          return respond(200, { item: decision.request });
        }
        case 'POST /patients/{id}/reassign': {
          const parsed = assignedClinicianBodySchema.safeParse(parseJsonBody(event));
          if (!parsed.success) {
            return respond(400, { error: 'INVALID_BODY', issues: parsed.error.issues });
          }
          const decision = await deps.repository.reassign(
            id,
            parsed.data.assignedClinicianId,
            actor,
          );
          return respond(200, { item: decision.request });
        }
        default:
          return respond(404, { error: 'NOT_FOUND' });
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
        return respond(404, { error: error.code });
      }
      if (
        error instanceof AppError &&
        (error.code === 'ALREADY_ASSIGNED' ||
          error.code === 'CLINICIAN_NOT_AVAILABLE' ||
          error.code === 'NOT_ASSIGNED')
      ) {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
