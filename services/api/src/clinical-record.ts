// TASK 3.2.1: diagnosis and care plan, versioned and clinician-authored,
// with an optional clinician-only private half — the first real entity
// R-09's chokepoint (`projection.ts`, TASK 2.1.2) is wired against, one
// phase after the boundary itself was built specifically so it would exist
// before any real private content did.
//
// Diagnosis and care plan share this one file, dispatched on `routeKey`,
// for the same reason `clinical-record-repository.ts` shares one class
// between them: `04-data-model-rbac.md` gives them identical matrix cells
// and an identical versioned shape, differing only in which sort-key
// prefix (`DIAG#`/`PLAN#`) a version lands under.
//
// No `PATCH`: a correction is a new version, not an edit to an existing
// one — `VersionedRepository.createVersion`'s own `AppError` on a repeat
// version number is what makes "overwrite version N" a thrown error
// rather than a route that would accept the request.
//
// **Who names the next version number.** `VersionedRepository` (TASK
// 0.3.3/2.1.2) has no "what's the latest version" method — 3.2.2 is the
// task that adds `listVersions`, deliberately not this one (this file's
// own scope per docs/plan/05-execution-plan.md). Until then, the caller
// states which version it is creating, the same way an `If-Match` ETag
// states which revision a client believes it is building on: a clinician
// revising a diagnosis they just read supplies that version's successor,
// and `createVersion`'s own guard turns a stale or duplicate guess into a
// thrown `VERSION_ALREADY_EXISTS` (mapped to `409` below) rather than a
// silent overwrite. Documented as a deliberate, scoped decision in
// docs/runbooks/clinical-record.md, not a gap discovered by accident.
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import type { ClinicalRecordInput, ClinicalRecordRepository } from './clinical-record-repository.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { PatientRepository } from './patient-repository.js';
import { projectFor, serialiseResponse, type ResponseBody } from './projection.js';
import { requirePrincipal } from './request-principal.js';

const CLINICAL_RECORDS_FLAG = 'clinicalRecords.enabled';

const clinicalRecordBodySchema = z
  .object({
    version: z.number().int().positive(),
    visible: z.object({ summary: z.string().min(1) }).strict(),
    private: z.object({ notes: z.string().min(1) }).strict().optional(),
  })
  .strict();

/** The two routes this file serves, and the entity type/repository each names — one lookup, not two parallel switch arms. */
const ROUTES = {
  'POST /patients/{id}/diagnosis': 'diagnosis',
  'POST /patients/{id}/care-plan': 'care-plan',
} as const satisfies Readonly<Record<string, 'diagnosis' | 'care-plan'>>;

export interface ClinicalRecordDeps {
  /** For the assignment-relationship lookup `can()` needs — never for a clinical read or write, which stay on `diagnosis`/`carePlan` below. */
  readonly patients: PatientRepository;
  readonly diagnosis: ClinicalRecordRepository;
  readonly carePlan: ClinicalRecordRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

const CLINICAL_RECORD_LOG_SAMPLE_RATE = 1;

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

export function createClinicalRecordHandler(
  deps: ClinicalRecordDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: CLINICAL_RECORD_LOG_SAMPLE_RATE });

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

    if (!(await deps.flags.isEnabled(CLINICAL_RECORDS_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    if (!(routeKey in ROUTES)) {
      return respond(404, { error: 'NOT_FOUND' });
    }
    const entityType = ROUTES[routeKey as keyof typeof ROUTES];

    const patientId = event.pathParameters?.id;
    if (!patientId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }

    // Fetched before `can()`, the same reason patient.ts's own handler
    // does: the sub-clinician column of this row depends on
    // `assigned_clinician_id`, which only the patient record can answer.
    // A patient role never reaches `create` on this row regardless (the
    // matrix's `'Patient (own)'` cell for `'Diagnosis / care plan'` is
    // bare `R`) — so the only principal that can ever observe a `404`
    // below is the principal clinician, who already has unrestricted
    // caseload visibility, and for whom "does this patient id exist" is
    // not a leak.
    const patient = await deps.patients.findById(patientId);
    const resource = {
      entityType,
      ownerPatientId: patientId,
      assignedClinicianId: patient?.assigned_clinician_id,
    } as const;

    if (!can(principal, 'create', resource).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }
    if (!patient) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    const parsed = clinicalRecordBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY' });
    }

    const input: ClinicalRecordInput = {
      visible: parsed.data.visible,
      // Conditionally spread, not `private: parsed.data.private`: zod
      // omits an absent optional key from its parsed output, but a bare
      // property assignment would still create the key on this new object
      // literal with value `undefined` — `Object.keys` sees a key either
      // way, and `ClinicalRecordInput['private']`'s own contract (and this
      // task's own test) requires the key fully absent, not present-and-
      // undefined, when a version carries no private notes.
      ...(parsed.data.private ? { private: parsed.data.private } : {}),
    };

    const actor = actorFromPrincipal(principal, requestOriginOf(event));
    const repository = entityType === 'diagnosis' ? deps.diagnosis : deps.carePlan;

    try {
      const created = await repository.createVersion(patientId, parsed.data.version, actor, input);
      return respond(201, { item: projectFor(principal, created, resource) });
    } catch (error) {
      if (error instanceof AppError && error.code === 'VERSION_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
