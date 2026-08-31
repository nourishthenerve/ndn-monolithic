// TASK 3.1.1: the patient's own profile, read and updated for real.
// `authz-matrix.ts`'s `'Patient profile'` row (`R U (self)` for the owning
// patient, `C R U` for either clinician role, `R U` for the principal) has
// stood fully implemented and exhaustively tested since TASK 2.1.1 with no
// handler ever calling it — this is that handler.
//
// The `PATCH` body's shape depends on who is calling, and that is a
// schema decision, not a wider matrix cell: the matrix's `R U` grants the
// *action*, not which fields. A patient-authored patch accepts
// `personal{}` only (never `email`, which stays bound to the Cognito
// identity that authenticated the request); a clinician-authored patch
// accepts both `personal{}` and `clinical{}`. Two schemas, one route,
// dispatched on `principal.role` — not two routes, because the matrix
// governs one resource either way.
//
// TASK 3.1.2: `GET /caseload/mine`, in this file rather than a new one —
// a small enough extension of the same `'Patient profile'` row that a
// second file would only be a second place to remember. Deliberately
// *not* `GET /caseload` (2.5.3's own path, the principal's cross-caseload
// view over GSI3) or a query parameter on it: a sub-clinician's own
// caseload and the principal's cross-caseload view are different queries
// against different indexes, and collapsing two differently-scoped reads
// onto one path is exactly the mistake TASK 2.5.4's own runbook found and
// reversed for `GET /testimonials`.
//
// No new matrix row for "list my own caseload": the resource passed to
// `can()` names the caller's *own* `clinicianId` as `assignedClinicianId`
// — the same "modelled as a resource assigned to themselves" trick
// `authz.ts`'s own comment documents for `'Own profile'`. A sub-clinician
// resolves to the already-granted `'Sub-clinician (assigned)'` column;
// the principal resolves to `'Principal'` regardless, as always; a
// patient (no `clinicianId` to self-assign) resolves to `'Patient
// (other)'` and is denied. The GSI1 query itself is what actually
// prevents seeing anyone else's caseload — it is keyed on the caller's
// own `clinicianId`, never a caller-suppliable parameter, so "cannot
// reach another clinician's caseload by any parameter" holds because
// there is no parameter that names one, the identical property 2.5.3's
// own `GET /caseload` already has.
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { PatientRepository } from './patient-repository.js';
import { projectFor, serialiseResponse, type ResponseBody } from './projection.js';
import { requirePrincipal } from './request-principal.js';

const PATIENT_PROFILE_FLAG = 'patients.profile.enabled';

/** The matrix row this file's every route is governed by — `authz-matrix.ts`'s `'Patient profile'`. */
const PATIENT_PROFILE_ENTITY_TYPE = 'patient-profile';

// `.strict()`: an unrecognised key — most pointedly a patient trying to
// smuggle `clinical` into their own patch — fails the parse with 400
// rather than being silently stripped. A caller that tries to write a
// field it cannot see should learn that, not be quietly ignored.
const personalPatchSchema = z
  .object({
    fullName: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    // 2026-08-31: a patient may keep their own address current, the same
    // as their phone — both are `personal{}` by patient.ts's own rule.
    address: z.string().min(1).optional(),
    marketingOptIn: z.boolean().optional(),
  })
  .strict();

const clinicalPatchSchema = z
  .object({
    referralSource: z.string().optional(),
    presentingCondition: z.string().optional(),
  })
  .strict();

const patientOwnPatchBodySchema = z
  .object({ personal: personalPatchSchema })
  .strict()
  .refine((body) => Object.keys(body.personal).length > 0, {
    message: 'personal patch must include at least one field',
  });

// 2026-08-31: `tag` is on the clinician patch and deliberately **not**
// on `patientOwnPatchBodySchema`. A patient must not be able to retag
// themselves: the tag decides which patients a `visitor` account can see
// (docs/runbooks/role-model.md), so it is an authorisation input, and an
// authorisation input the subject can edit is not one. `.strict()` above
// is what makes that a 400 rather than a silent strip.
const clinicianPatchBodySchema = z
  .object({
    personal: personalPatchSchema.optional(),
    clinical: clinicalPatchSchema.optional(),
    tag: z.enum(['IIC', 'NDN']).optional(),
  })
  .strict()
  .refine(
    (body) =>
      (body.personal !== undefined && Object.keys(body.personal).length > 0) ||
      (body.clinical !== undefined && Object.keys(body.clinical).length > 0) ||
      body.tag !== undefined,
    { message: 'at least one field must be given' },
  );

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

export interface PatientDeps {
  readonly repository: PatientRepository;
  readonly flags: FlagReader;
  /** GSI1: every patient id currently assigned to `clinicianId` — the same read `assignment-repository.ts`'s own `listPatientIdsForClinician` exposes, injected here as a port rather than a concrete repository dependency. */
  readonly listPatientIdsForClinician: (clinicianId: string) => Promise<string[]>;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

const PATIENT_LOG_SAMPLE_RATE = 1;

export function createPatientHandler(
  deps: PatientDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createSampledLogger({ clock, sampleRate: PATIENT_LOG_SAMPLE_RATE });

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

    if (!(await deps.flags.isEnabled(PATIENT_PROFILE_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    if (routeKey === 'GET /caseload/mine') {
      // `principal.clinicianId` is `undefined` for a patient principal —
      // `can()`'s own `resolveColumn` then compares `undefined ===
      // principal.patientId`, which is never true, landing them on
      // `'Patient (other)'` and denying them. No special-cased "reject
      // patients" branch needed here.
      const resource = {
        entityType: PATIENT_PROFILE_ENTITY_TYPE,
        assignedClinicianId: principal.clinicianId,
      } as const;
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      // `clinicianId` is guaranteed non-empty for both clinician roles by
      // `requirePrincipal`'s own schema — the `can()` check above already
      // depended on it being set, so this is never reached for a
      // principal with none.
      const clinicianId = principal.clinicianId as string;
      const ids = await deps.listPatientIdsForClinician(clinicianId);
      const items: { readonly patientId: string; readonly fullName: string }[] = [];
      for (const patientId of ids) {
        const patient = await deps.repository.findById(patientId);
        // A patient can fall out of the caseload between the index read
        // and this follow-up `GetItem` (reassigned, declined) — GSI1 is
        // eventually consistent with the write that produced it, so a row
        // that no longer belongs is skipped rather than surfaced stale,
        // the identical property `caseload-repository.ts`'s own `listPage`
        // already keeps for GSI3.
        if (!patient || patient.assigned_clinician_id !== clinicianId) {
          continue;
        }
        const projected = projectFor(principal, patient, resource);
        items.push({ patientId, fullName: projected.personal?.fullName ?? '' });
      }
      // Plain `JSON.stringify`, not `respond`/`serialiseResponse`: `items`
      // is already a derived, plain-scalar shape squeezed out of a
      // `Projected` record (the `projectFor` call above), not a record
      // `ResponseBody` needs to gate — the identical choice `caseload.ts`
      // (2.5.3) already makes for the same kind of derived list.
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: routeKey,
        statusCode: 200,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items }),
      };
    }

    const rawId = event.pathParameters?.id;
    if (!rawId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }
    // `/patients/me` resolves to the caller's own record for a patient
    // principal — the frontend's `SessionClient` never decodes the access
    // token's claims (deliberately: `session.ts`'s whole point is that the
    // token is a closure-held opaque string), so it has no other way to
    // learn its own patient id before making the very request that would
    // need it. A clinician has no `patientId` to resolve `me` against —
    // `can()` denies a clinician's `me` request the same way it denies any
    // other malformed principal, via `resolveColumn`'s existing check,
    // once `id` below is left as the literal string `'me'` (which matches
    // no real record and therefore no relationship column either).
    const id =
      rawId === 'me' && principal.role === 'patient' ? (principal.patientId ?? rawId) : rawId;

    // Fetched before `can()` runs — not to skip the check, but because
    // the sub-clinician column of this row depends on
    // `assigned_clinician_id`, which only the record itself can answer.
    // `ownerPatientId` is always the path parameter, never derived from
    // whether the record was found, so a guess at another patient's id and
    // a guess at a nonexistent one are denied identically (`403`, not a
    // `404` that would leak which is which) — the same "a denied caller
    // must not be able to tell a well-formed request from a malformed one
    // by the shape of the refusal" rule `audit-read.ts` states for its own
    // route.
    const existing = await deps.repository.findById(id);
    const resource = {
      entityType: PATIENT_PROFILE_ENTITY_TYPE,
      ownerPatientId: id,
      assignedClinicianId: existing?.assigned_clinician_id,
    } as const;

    switch (routeKey) {
      case 'GET /patients/{id}': {
        if (!can(principal, 'read', resource).allowed) {
          return respond(403, { error: 'FORBIDDEN' });
        }
        if (!existing) {
          return respond(404, { error: 'RECORD_NOT_FOUND' });
        }
        return respond(200, { item: projectFor(principal, existing, resource) });
      }

      case 'PATCH /patients/{id}': {
        if (!can(principal, 'update', resource).allowed) {
          return respond(403, { error: 'FORBIDDEN' });
        }
        if (!existing) {
          return respond(404, { error: 'RECORD_NOT_FOUND' });
        }

        // The error body carries no `issues` array, unlike
        // content-authoring.ts's own INVALID_BODY response — this handler
        // uses `serialiseResponse`/`ResponseBody` (projection.ts) for the
        // discipline its own header states, and `ResponseBody` only
        // accepts scalars and projected records, not an arbitrary
        // Zod-issue array. A minimal error body is what audit-read.ts's
        // own 400s already carry for the same reason.
        const isSelfPatch = principal.role === 'patient';
        const parsed = isSelfPatch
          ? patientOwnPatchBodySchema.safeParse(parseJsonBody(event))
          : clinicianPatchBodySchema.safeParse(parseJsonBody(event));
        if (!parsed.success) {
          return respond(400, { error: 'INVALID_BODY' });
        }

        const actor = actorFromPrincipal(principal, requestOriginOf(event));
        const updated = await deps.repository.update(id, actor, parsed.data);
        return respond(200, { item: projectFor(principal, updated, resource) });
      }

      default:
        return respond(404, { error: 'NOT_FOUND' });
    }
  };
}
