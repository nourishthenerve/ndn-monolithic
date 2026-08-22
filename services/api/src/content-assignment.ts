// TASK 3.5.1: content assignment — a clinician linking existing,
// published content to a patient, and the patient's own hydrated read of
// the list. Two routes, one file, the same split every other patient-
// scoped entity in this phase uses: `POST /patients/{id}/content`
// (assign), `GET /patients/{id}/content` (list, hydrated with
// title/excerpt — never a bare `contentId` the frontend would need a
// second round trip to resolve).
//
// A real finding, matching the identical mistake `assessment.ts`'s own
// header and `appointment.ts`'s own header both name: `authz-matrix.ts`'s
// `Content assignment` row grants the `Principal` column bare `R`, not
// `C R U` — only the assigned sub-clinician assigns content, the same
// "whoever is actually delivering care authors it" design already
// established twice this phase. The `if (!patient) return 404` branch
// below is unreachable by construction for the same reason, and for the
// same reason: kept as defence in depth, not removed.
//
// `/patients/me/content` resolves "me" via the same `/me` trick
// `patient.ts`/`clinical-record.ts`/`appointment.ts` already give their
// own patient routes.
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type { ContentAssignmentRepository } from './content-assignment-repository.js';
import { CONTENT_ASSIGNMENT_ENTITY_TYPE } from './content-assignment-repository.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { PatientRepository } from './patient-repository.js';
import { projectAllFor, projectFor, serialiseResponse, type ResponseBody } from './projection.js';
import { requirePrincipal } from './request-principal.js';

function parseJsonBody(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) {
    return undefined;
  }
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf-8')
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

const CONTENT_ASSIGNMENT_FLAG = 'contentAssignment.enabled';

const assignBodySchema = z.object({ contentId: z.string().min(1) }).strict();

export interface ContentAssignmentDeps {
  /** For the assignment-relationship lookup `can()` needs — never for an assignment read or write, which stays on `assignments` below. */
  readonly patients: PatientRepository;
  readonly assignments: ContentAssignmentRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

const CONTENT_ASSIGNMENT_LOG_SAMPLE_RATE = 1;

export function createContentAssignmentHandler(
  deps: ContentAssignmentDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: CONTENT_ASSIGNMENT_LOG_SAMPLE_RATE });

  return async (event) => {
    const start = clock.now();
    const routeKey = event.routeKey ?? '';

    const respond = (statusCode: number, body: ResponseBody) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: serialiseResponse(body),
      };
    };

    if (!(await deps.flags.isEnabled(CONTENT_ASSIGNMENT_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const isAssign = routeKey === 'POST /patients/{id}/content';
    const isList = routeKey === 'GET /patients/{id}/content';
    if (!isAssign && !isList) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const rawId = event.pathParameters?.id;
    if (!rawId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }
    const patientId =
      rawId === 'me' && principal.role === 'patient' ? (principal.patientId ?? rawId) : rawId;

    // Fetched before `can()`, the same reason every other patient-scoped
    // handler in this codebase does: the sub-clinician column depends on
    // `assigned_clinician_id`, which only the patient record can answer.
    const patient = await deps.patients.findById(patientId);
    const resource = {
      entityType: CONTENT_ASSIGNMENT_ENTITY_TYPE,
      ownerPatientId: patientId,
      assignedClinicianId: patient?.assigned_clinician_id,
    } as const;

    if (isList) {
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      if (!patient) {
        return respond(404, { error: 'RECORD_NOT_FOUND' });
      }
      const items = await deps.assignments.listForPatient(patientId);
      const projected = projectAllFor(principal, items, resource);
      return respond(200, { items: projected });
    }

    if (!can(principal, 'create', resource).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }
    // Unreachable by construction today, kept as defence in depth rather
    // than removed — the identical reasoning assessment.ts's and
    // appointment.ts's own identical-looking lines state:
    // `Content assignment`'s own `Principal` cell is bare `R`
    // (`authz-matrix.ts`, standing since TASK 2.1.1), and only the
    // `'Sub-clinician (assigned)'` column ever reaches `create`, which
    // can never resolve without `patient` existing.
    if (!patient) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    const parsed = assignBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY' });
    }

    const actor = actorFromPrincipal(principal, requestOriginOf(event));
    try {
      const created = await deps.assignments.assign(patientId, parsed.data.contentId, actor);
      return respond(201, { item: projectFor(principal, created, resource) });
    } catch (error) {
      if (error instanceof AppError && error.code === 'CONTENT_NOT_PUBLISHED') {
        return respond(400, { error: error.code });
      }
      if (error instanceof AppError && error.code === 'RECORD_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
