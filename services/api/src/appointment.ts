// TASK 3.4.1: appointments, and GSI1's second half — the clinician
// calendar. `docs/adr/0002-database.md` proved this task's own access
// pattern before either GSI1 or this entity existed: "`gsi1pk =
// CLI#<clinicianId>` AND `gsi1sk BETWEEN 'APPT#<start>' AND 'APPT#<end>'`
// … key shape checked now, while the index is still cheap to shape."
//
// Three routes, one file: `POST /patients/{id}/appointments` (schedule),
// `GET /clinicians/me/calendar?from=&to=` (the clinician's own calendar,
// GSI1), `GET /patients/{id}/appointments` (a patient's own list,
// main-table). No `PATCH`/cancel here — TASK 3.4.2's own scope.
//
// A real finding, matching the identical mistake `assessment.ts`'s own
// header names for its write row: `authz-matrix.ts`'s `Appointments` row
// grants the `Principal` column bare `R`, not `C R U` — only the assigned
// sub-clinician schedules an appointment, the same "whoever is actually
// delivering care authors it" design assessment forms already established.
// The `if (!patient) return 404` branch below is unreachable by
// construction for the same reason assessment.ts's own is, and for the
// same reason: kept as defence in depth, not removed.
//
// `GET /clinicians/me/calendar` resolves "me" the same "self-assigned
// resource" trick `patient.ts`'s own `GET /caseload/mine` uses:
// `assignedClinicianId: principal.clinicianId` names the caller's own id,
// so a sub-clinician lands on the already-granted `'Sub-clinician
// (assigned)'` column and a principal lands on `'Principal'` — no new
// matrix row, and structurally no parameter through which a caller could
// name a different clinician's calendar (05-execution-plan.md's own "Do
// NOT: let the calendar query accept a clinicianId parameter a caller
// could point at someone else").
import type { Principal } from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import type { AppointmentInput, AppointmentRepository } from './appointment-repository.js';
import { APPOINTMENT_ENTITY_TYPE } from './appointment-repository.js';
import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
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

const APPOINTMENTS_FLAG = 'appointments.enabled';

const scheduleBodySchema = z
  .object({
    scheduledAt: z.string().datetime(),
    durationMinutes: z.number().int().positive(),
  })
  .strict();

export interface AppointmentDeps {
  /** For the assignment-relationship lookup `can()` needs — never for an appointment read or write, which stays on `appointments` below. */
  readonly patients: PatientRepository;
  readonly appointments: AppointmentRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

const APPOINTMENT_LOG_SAMPLE_RATE = 1;

export function createAppointmentHandler(
  deps: AppointmentDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: APPOINTMENT_LOG_SAMPLE_RATE });

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

    if (!(await deps.flags.isEnabled(APPOINTMENTS_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    if (routeKey === 'GET /clinicians/me/calendar') {
      // A patient principal has no `clinicianId` at all — `resource`
      // below then names `assignedClinicianId: undefined`, which can
      // never equal a patient's own (non-empty) `patientId` comparison
      // path in `resolveColumn`'s `'patient'` branch, landing them on
      // `'Patient (other)'` and denying them, the same "no special-cased
      // rejection needed" shape `GET /caseload/mine` already relies on.
      const resource = {
        entityType: APPOINTMENT_ENTITY_TYPE,
        assignedClinicianId: principal.clinicianId,
      } as const;
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      const from = event.queryStringParameters?.from;
      const to = event.queryStringParameters?.to;
      if (!from || !to) {
        return respond(400, { error: 'RANGE_REQUIRED' });
      }
      // `clinicianId` is guaranteed non-empty for both clinician roles by
      // `requirePrincipal`'s own schema — the `can()` check above already
      // depended on it being set for a sub-clinician, and a principal's
      // own `clinicianId` is always their own subject id regardless.
      const clinicianId = principal.clinicianId as string;
      const appointments = await deps.appointments.listForClinicianCalendar(
        clinicianId,
        from,
        to,
      );
      const items = projectAllFor(principal, appointments, resource);
      return respond(200, { items });
    }

    const isPost = routeKey === 'POST /patients/{id}/appointments';
    const isGet = routeKey === 'GET /patients/{id}/appointments';
    if (!isPost && !isGet) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const rawId = event.pathParameters?.id;
    if (!rawId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }
    // `/patients/me/appointments` — the identical `/me` resolution
    // `patient.ts`/`clinical-record.ts` already give their own patient
    // routes, needed for the identical reason: the account page's
    // "next appointment" panel has no other way to learn its own id.
    const patientId =
      rawId === 'me' && principal.role === 'patient' ? (principal.patientId ?? rawId) : rawId;

    // Fetched before `can()`, the same reason every other patient-scoped
    // handler in this codebase does: the sub-clinician column depends on
    // `assigned_clinician_id`, which only the patient record can answer.
    const patient = await deps.patients.findById(patientId);
    const resource = {
      entityType: APPOINTMENT_ENTITY_TYPE,
      ownerPatientId: patientId,
      assignedClinicianId: patient?.assigned_clinician_id,
    } as const;

    if (isGet) {
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      if (!patient) {
        return respond(404, { error: 'RECORD_NOT_FOUND' });
      }
      const appointments = await deps.appointments.listForPatient(patientId);
      const items = projectAllFor(principal, appointments, resource);
      return respond(200, { items });
    }

    if (!can(principal, 'create', resource).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }
    // Unreachable by construction today, kept as defence in depth rather
    // than removed — the identical reasoning assessment.ts's own
    // identical-looking line states: `Appointments`'s own `Principal`
    // cell is bare `R` (`authz-matrix.ts`, standing since TASK 2.1.1),
    // and only the `'Sub-clinician (assigned)'` column ever reaches
    // `create`, which can never resolve without `patient` existing.
    if (!patient) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    const parsed = scheduleBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY' });
    }

    const input: AppointmentInput = {
      patientId,
      // The caller's own id — only the assigned sub-clinician ever
      // reaches this line, so the appointment is always scheduled as
      // themselves, never a clinician id the request body could name.
      clinicianId: principal.clinicianId as string,
      scheduledAt: parsed.data.scheduledAt,
      durationMinutes: parsed.data.durationMinutes,
    };

    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    try {
      const created = await deps.appointments.schedule(input, actor);
      return respond(201, { item: projectFor(principal, created, resource) });
    } catch (error) {
      if (error instanceof AppError && error.code === 'APPOINTMENT_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
