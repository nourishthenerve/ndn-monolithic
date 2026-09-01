// TASK 3.4.1: appointments, and GSI1's second half — the clinician
// calendar. `docs/adr/0002-database.md` proved this task's own access
// pattern before either GSI1 or this entity existed: "`gsi1pk =
// CLI#<clinicianId>` AND `gsi1sk BETWEEN 'APPT#<start>' AND 'APPT#<end>'`
// … key shape checked now, while the index is still cheap to shape."
//
// Four routes, one file: `POST /patients/{id}/appointments` (schedule),
// `GET /clinicians/me/calendar?from=&to=` (the clinician's own calendar,
// GSI1), `GET /patients/{id}/appointments` (a patient's own list,
// main-table), `POST /patients/{id}/appointments/{apptId}/cancel` (TASK
// 3.4.2). No `PATCH` that changes `scheduledAt`: rescheduling is
// cancel-the-old, `POST` a new one, so the append-only property every
// entity in this table keeps holds here without a special case.
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
import type { PatientNotificationKind, Principal } from '@ndn/shared-types';
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
import type { PatientNotificationRepository } from './patient-notification-repository.js';
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

/** The `Appointment approval` row — a different row from `Appointments`, and `Principal`-only. See docs/plan/04-data-model-rbac.md's own note on why approving is not a widening of booking. */
const APPOINTMENT_APPROVAL_ENTITY_TYPE = 'appointment-approval';

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
  /**
   * 2026-09-01: the patient's in-app dashboard feed. Written as a side
   * effect of the four calendar actions below, never by a route of its
   * own — `authz-matrix.ts`'s `Patient notifications` row grants `C` to
   * nobody, so this is the only way a notice is ever created.
   */
  readonly notifications: PatientNotificationRepository;
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

    const isSchedule = routeKey === 'POST /patients/{id}/appointments';
    const isList = routeKey === 'GET /patients/{id}/appointments';
    const isCancel = routeKey === 'POST /patients/{id}/appointments/{apptId}/cancel';
    const isApprove = routeKey === 'POST /patients/{id}/appointments/{apptId}/approve';
    const isDecline = routeKey === 'POST /patients/{id}/appointments/{apptId}/decline';
    const isComplete = routeKey === 'POST /patients/{id}/appointments/{apptId}/complete';
    const isNoShow = routeKey === 'POST /patients/{id}/appointments/{apptId}/no-show';
    if (
      !isSchedule &&
      !isList &&
      !isCancel &&
      !isApprove &&
      !isDecline &&
      !isComplete &&
      !isNoShow
    ) {
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
    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    /**
     * Every calendar action ends here. **Deliberately not fatal**: the
     * appointment is already written by the time this runs, and throwing
     * would report failure for an action that succeeded, leaving the
     * caller to retry a booking that already exists (and collide with it).
     * **And deliberately not silent**: the outcome is returned as
     * `notified`, so a caller is told rather than left to infer it from
     * the patient's screen. The same shape `POST /patients` uses for the
     * assessment form it instantiates.
     */
    const notify = async (
      kind: PatientNotificationKind,
      about: { readonly subjectAt?: string } = {},
    ): Promise<boolean> => {
      try {
        await deps.notifications.notify(patientId, kind, actor, about);
        return true;
      } catch {
        return false;
      }
    };

    if (isApprove || isDecline) {
      // The `Appointment approval` row, not `Appointments` — a
      // sub-clinician holds `update` on the latter and is denied here,
      // which is the entire mechanism behind "any new appointment booked
      // by the clinician needs to be approved by the principal clinician."
      if (
        !can(principal, 'update', {
          entityType: APPOINTMENT_APPROVAL_ENTITY_TYPE,
          ownerPatientId: patientId,
          assignedClinicianId: patient?.assigned_clinician_id,
        }).allowed
      ) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      if (!patient) {
        return respond(404, { error: 'RECORD_NOT_FOUND' });
      }
      const apptId = event.pathParameters?.apptId;
      if (!apptId) {
        return respond(400, { error: 'ID_REQUIRED' });
      }
      try {
        const decided = isApprove
          ? await deps.appointments.approve(patientId, apptId, actor)
          : await deps.appointments.decline(patientId, apptId, actor);
        const notified = await notify(
          isApprove ? 'appointment-approved' : 'appointment-cancelled',
          { subjectAt: decided.scheduledAt },
        );
        return respond(200, { item: projectFor(principal, decided, resource), notified });
      } catch (error) {
        if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
          return respond(404, { error: error.code });
        }
        // Already approved, already declined, or never pending — the
        // condition expression refused the write rather than letting a
        // second decision overwrite the first.
        if (error instanceof AppError && error.code === 'APPOINTMENT_STATE_CONFLICT') {
          return respond(409, { error: error.code });
        }
        throw error;
      }
    }

    // 2026-09-01: marking attendance. On the `Appointments` row's own
    // `update`, not the approval row — recording that a session happened is
    // the treating clinician's, and the principal holds the same cell.
    // Without these two routes `appointment_status` would never once be
    // `'completed'`, and both the visitor's "number of appointments
    // happened" and the calendar section's "sessions so far" would read
    // zero forever — a wrong figure that looks like a right one.
    if (isComplete || isNoShow) {
      if (!can(principal, 'update', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      if (!patient) {
        return respond(404, { error: 'RECORD_NOT_FOUND' });
      }
      const apptId = event.pathParameters?.apptId;
      if (!apptId) {
        return respond(400, { error: 'ID_REQUIRED' });
      }
      try {
        const marked = await deps.appointments.markAttended(
          patientId,
          apptId,
          actor,
          isComplete ? 'completed' : 'no-show',
        );
        // No notification: the patient was there (or was not), so telling
        // them about it on their dashboard is noise. The feed exists for
        // changes to what is *coming*, which is what the owner asked for.
        return respond(200, { item: projectFor(principal, marked, resource) });
      } catch (error) {
        if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
          return respond(404, { error: error.code });
        }
        // Not `scheduled` — cancelled, still awaiting approval, or already
        // marked. None of those took place, and none may be recorded as
        // though they had.
        if (error instanceof AppError && error.code === 'APPOINTMENT_STATE_CONFLICT') {
          return respond(409, { error: error.code });
        }
        throw error;
      }
    }

    if (isList) {
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

    if (isCancel) {
      // TASK 3.4.2: `can()` gates `cancel` with `'update'`, the same
      // action `create` reaches — `Appointments`'s own matrix row grants
      // both to the identical single column (`'Sub-clinician
      // (assigned)'` only), so a patient is denied here for the same
      // reason they never reach booking in the first place.
      if (!can(principal, 'update', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      // Unreachable by construction today, kept as defence in depth —
      // the identical reasoning the `create` branch's own line states.
      if (!patient) {
        return respond(404, { error: 'RECORD_NOT_FOUND' });
      }
      const apptId = event.pathParameters?.apptId;
      if (!apptId) {
        return respond(400, { error: 'ID_REQUIRED' });
      }
      try {
        const cancelled = await deps.appointments.cancel(patientId, apptId, actor);
        const notified = await notify('appointment-cancelled', {
          subjectAt: cancelled.scheduledAt,
        });
        return respond(200, { item: projectFor(principal, cancelled, resource), notified });
      } catch (error) {
        if (error instanceof AppError && error.code === 'RECORD_NOT_FOUND') {
          return respond(404, { error: error.code });
        }
        throw error;
      }
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

    // 2026-09-01: "any new appointment booked by the clinician needs to be
    // approved by the principal clinician." The principal is the approver,
    // so their own booking is confirmed on the spot — approving yourself
    // is a step with no decision in it, and one that would either be done
    // reflexively or forgotten, which makes the state mean less rather
    // than more. Read off `principal.role` rather than off `can()`,
    // because this is not an authorisation question: both roles are
    // already authorised to book by the line above, and what differs is
    // what the booking *is*.
    const requiresApproval = principal.role !== 'principal-clinician';

    try {
      const created = await deps.appointments.schedule(input, actor, { requiresApproval });
      const notified = await notify(
        requiresApproval ? 'appointment-requested' : 'appointment-approved',
        { subjectAt: created.scheduledAt },
      );
      return respond(201, { item: projectFor(principal, created, resource), notified });
    } catch (error) {
      if (error instanceof AppError && error.code === 'APPOINTMENT_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
