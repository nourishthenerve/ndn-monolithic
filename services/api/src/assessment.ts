// TASK 3.3.1: assessment forms — the entity `authz-matrix.ts` has carried
// two dedicated matrix rows for (`'Assessment — visible{}'`, `'Assessment
// — private{}'`) since TASK 2.1.1, and `authz.test.ts`'s exhaustive suite
// has asserted every cell of both since the same task, including the row
// R-09's own register entry names directly: "a patient reaches no
// private assessment field, in any relationship." No assessment record
// has existed for any of that to run against a real handler until now.
//
// Unlike diagnosis/care-plan's single matrix row with an internal
// visible/private split (clinical-record.ts, TASK 3.2.1), an assessment
// is genuinely **two matrix rows for one entity** — `resolveRow`
// (authz.ts) branches on `fieldSet` for this entity type alone, so every
// `can()` call here names one explicitly. `create`/`update` reach the
// `'Assessment — visible{}'` row only: an assigned sub-clinician or the
// principal can write the visible half, and a `private{}` value on that
// same write is permitted by construction of the request shape, not a
// second authorisation call — writing is one action on one record;
// reading (3.3.2) is where the two-row split actually matters.
//
// No `PATCH`: a correction is a new version, not an edit to an existing
// one, the identical append-only reasoning `clinical-record.ts` already
// states for diagnosis/care-plan.
//
// TASK 3.3.2: `GET /patients/{id}/assessments/{assessmentId}` — every
// version, newest first. This is where the two-row split actually
// matters, and it is built deliberately unlike `clinical-record.ts`'s own
// read handler: rather than fetching the full record and letting
// `projectFor` strip `private{}` after the fact, this handler decides
// *which shape to build* before ever touching `version.private` — a
// patient's (or anyone denied the private row's) response is built from
// an object literal that never had a `private` key to begin with, not
// one that had it and lost it. `can()` is asked twice, once per
// `fieldSet`, exactly as 3.3.1's own header states for the write side:
// never once with a fabricated "give me everything" resource. Every
// object still passes through `projectFor` before `respond()` — for the
// visible-only shape this is a provable no-op (there is no `private` key
// present to strip), so it costs nothing and keeps the "every response
// goes through `projectFor`" discipline this codebase holds everywhere
// else, rather than carving out a silent exception for this one route.
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import type { AssessmentInput, AssessmentRepository } from './assessment-repository.js';
import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { ASSESSMENT_ENTITY_TYPE } from './authz-matrix.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { PatientRepository } from './patient-repository.js';
import { projectFor, serialiseResponse, type ResponseBody } from './projection.js';
import { requirePrincipal } from './request-principal.js';

const ASSESSMENTS_FLAG = 'assessments.enabled';

const assessmentBodySchema = z
  .object({
    version: z.number().int().positive(),
    visible: z
      .object({
        formType: z.string().min(1),
        responses: z.record(z.string(), z.unknown()),
      })
      .strict(),
    private: z.object({ clinicianImpression: z.string().min(1) }).strict().optional(),
  })
  .strict();

export interface AssessmentDeps {
  /** For the assignment-relationship lookup `can()` needs — never for an assessment read or write, which stays on `assessments` below. */
  readonly patients: PatientRepository;
  readonly assessments: AssessmentRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

const ASSESSMENT_LOG_SAMPLE_RATE = 1;

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

export function createAssessmentHandler(
  deps: AssessmentDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: ASSESSMENT_LOG_SAMPLE_RATE });

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

    if (!(await deps.flags.isEnabled(ASSESSMENTS_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const isGet = routeKey === 'GET /patients/{id}/assessments/{assessmentId}';
    const isPost = routeKey === 'POST /patients/{id}/assessments/{assessmentId}';
    if (!isGet && !isPost) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const patientId = event.pathParameters?.id;
    const assessmentId = event.pathParameters?.assessmentId;
    if (!patientId || !assessmentId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }

    // Fetched before `can()`, the same reason clinical-record.ts's own
    // handler does: the sub-clinician column depends on
    // `assigned_clinician_id`, which only the patient record can answer.
    const patient = await deps.patients.findById(patientId);
    const resource = {
      entityType: ASSESSMENT_ENTITY_TYPE,
      ownerPatientId: patientId,
      assignedClinicianId: patient?.assigned_clinician_id,
      fieldSet: 'visible',
    } as const;

    if (isGet) {
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      if (!patient) {
        return respond(404, { error: 'RECORD_NOT_FOUND' });
      }
      // A second, independent `can()` call against the private row — not
      // a fabricated "give me everything" resource, and not inferred
      // from the visible-row decision above, which says nothing about
      // the private row at all.
      const mayReadPrivate = can(principal, 'read', {
        ...resource,
        fieldSet: 'private',
      }).allowed;

      const versions = await deps.assessments.listVersions(patientId, assessmentId);
      const items = versions
        .slice()
        .reverse()
        .map((version) =>
          mayReadPrivate
            ? projectFor(
                principal,
                { version: version.version, visible: version.visible, private: version.private },
                resource,
              )
            : projectFor(principal, { version: version.version, visible: version.visible }, resource),
        );
      return respond(200, { items });
    }

    if (!can(principal, 'create', resource).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }
    // Unreachable by construction today, kept as defence in depth rather
    // than removed: `'Assessment — visible{}'`'s own `Principal` cell is
    // bare `R` (`authz-matrix.ts`, standing since TASK 2.1.1) — only the
    // `'Sub-clinician (assigned)'` column ever reaches `create` on this
    // row, and that column can never resolve without `patient` existing
    // (`assignedClinicianId` is `undefined` for a nonexistent patient,
    // which can never equal a principal's own non-empty `clinicianId`).
    // Unlike clinical-record.ts's identical-looking line — where the
    // principal *does* hold unconditional `create` and this branch is a
    // real, exercised path — this one only guards against a future
    // widening of that one matrix cell.
    if (!patient) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    const parsed = assessmentBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY' });
    }

    const input: AssessmentInput = {
      visible: parsed.data.visible,
      // Conditionally spread — see clinical-record.ts's own identical
      // comment: zod omits an absent optional key, but a bare property
      // assignment on this new object literal would still create the key
      // with value `undefined`, which `Object.keys`/`hasOwnProperty`
      // would see either way.
      ...(parsed.data.private ? { private: parsed.data.private } : {}),
    };

    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    try {
      const created = await deps.assessments.createVersion(
        patientId,
        assessmentId,
        parsed.data.version,
        actor,
        input,
      );
      return respond(201, { item: projectFor(principal, created, resource) });
    } catch (error) {
      if (error instanceof AppError && error.code === 'VERSION_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
