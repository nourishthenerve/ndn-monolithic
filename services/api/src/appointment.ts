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
// **Superseded 2026-09-03.** This header used to state that
// `authz-matrix.ts`'s `Appointments` row grants the `Principal` column
// bare `R`, so "only the assigned sub-clinician schedules an appointment".
// That was true when it was written and stopped being true on 2026-08-31,
// when the principal became a practising clinician with `C R U J` — and
// the `clinicianId` line below still assumed it, attaching every
// principal-booked appointment to the principal instead of to the
// clinician treating the patient. See that line's own note. The
// `if (!patient) return 404` branch remains defence in depth.
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
import { TREATING_CLINICIAN_ROLES } from '@ndn/shared-types';
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
import type { ClinicianRepository } from './clinician-repository.js';
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

/** The `Patient profile` row, restated as `patient.ts` and `caseload-repository.ts` each restate it — what gates the patient *name* on a read below, which is a different question from what gates the appointment. */
const PATIENT_PROFILE_ENTITY_TYPE = 'patient-profile';

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
   * 2026-09-06: display names for the two people an appointment is about.
   * Read-only here, and only on the two list routes — this handler never
   * creates or updates a clinician record.
   */
  readonly clinicians: ClinicianRepository;
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

    // ## 2026-09-06: the two names an appointment is *about*
    //
    // The owner: *"on calender when we click an appointment it should also
    // show the name of the patient and the name of the clinician."*
    //
    // An appointment stores `patientId` and `clinicianId` and no names at
    // all — deliberately, and this file already says why on `approvedBy`:
    // "An identifier, never a name." That decision is not being reversed;
    // the names are *joined on the way out* of the two read routes and never
    // written to the row, so the record stays the single-source id it was.
    //
    // **The promise is cached, not the name.** A clinician's fortnight is
    // one clinician and a handful of patients repeated across it, and a
    // patient's whole history is one patient and usually one clinician —
    // so nearly every lookup is a repeat. Caching the settled value alone
    // would still let the concurrent lookups inside one `Promise.all` each
    // fire their own read for the same id before any of them resolved.
    const patientNameCache = new Map<string, Promise<string | undefined>>();
    const clinicianNameCache = new Map<string, Promise<string | undefined>>();
    const assignedClinicianNameCache = new Map<string, Promise<string | undefined>>();

    // The patient record, fetched once per id and shared by the name lookup
    // and the assigned-clinician lookup below — both read it, and one
    // `findById` per patient beats two. A read that fails is `undefined`, the
    // same posture the name lookups take: a directory hiccup must not turn a
    // working calendar into a 500.
    type PatientRecord = Awaited<ReturnType<typeof deps.patients.findById>>;
    const patientRecordCache = new Map<string, Promise<PatientRecord>>();
    const patientRecordFor = (id: string): Promise<PatientRecord> => {
      const cached = patientRecordCache.get(id);
      if (cached) {
        return cached;
      }
      const pending = deps.patients.findById(id).catch(() => undefined);
      patientRecordCache.set(id, pending);
      return pending;
    };

    /**
     * The patient's name — **only if this caller could read that patient's
     * profile anyway.**
     *
     * Gated on the `Patient profile` row rather than inherited from the
     * `Appointments` read that got us this far, because the two are not the
     * same grant: `Appointments` hands `Visitor` and `Helpdesk` a plain `R`,
     * and an appointment naming a patient the caller may not look up would
     * disclose more than either row allows on its own. Where the two rows
     * agree the name simply appears; where they disagree the field is
     * **absent rather than blank**, so the client can tell "no name for you"
     * from "this person has no name recorded".
     */
    const patientNameFor = (id: string): Promise<string | undefined> => {
      const cached = patientNameCache.get(id);
      if (cached) {
        return cached;
      }
      const pending = (async () => {
        const record = await patientRecordFor(id);
        if (!record) {
          return undefined;
        }
        const profile = {
          entityType: PATIENT_PROFILE_ENTITY_TYPE,
          ownerPatientId: id,
          assignedClinicianId: record.assigned_clinician_id,
        } as const;
        if (!can(principal, 'read', profile).allowed) {
          return undefined;
        }
        // Projected before a field is read off it, the same way
        // `caseload-repository.ts` reads this exact field — `fullName` is
        // not itself private, but reading a record's field without going
        // through the boundary is the habit this codebase does not keep.
        return projectFor(principal, record, profile).personal?.fullName || undefined;
      })();
      patientNameCache.set(id, pending);
      return pending;
    };

    /**
     * The clinician's display name.
     *
     * **Not** gated on `Clinician accounts`: that row governs administering
     * clinician records, and gating on it would hide a patient's own
     * clinician's name from them — the half of this request that matters
     * most. `caseload-repository.ts` already sets the precedent, returning
     * `assignedClinicianName` to every role that may see the care
     * relationship without consulting that row. A display name is the name
     * of the person providing the care the caller is already looking at.
     */
    const clinicianNameFor = (id: string): Promise<string | undefined> => {
      const cached = clinicianNameCache.get(id);
      if (cached) {
        return cached;
      }
      const pending = deps.clinicians
        .findById(id)
        .then((record) => record?.displayName || undefined)
        // A name is decoration on a row that is already authorised and
        // already useful. A directory read that fails must not turn a
        // working calendar into a 500.
        .catch(() => undefined);
      clinicianNameCache.set(id, pending);
      return pending;
    };

    /**
     * The name of the clinician a patient is **assigned to** — a different
     * fact from the clinician on any one appointment (who conducts it), which
     * `clinicianNameFor` already gives. The principal's next-appointment lead
     * shows this so a principal covering someone else's session can see whose
     * patient it really is.
     *
     * Gated on the same care-relationship read `patientNameFor` uses: the
     * assignment is a fact about the patient, disclosed only to a caller who
     * may read that patient's profile — which is exactly the role
     * `caseload-repository.ts` already returns `assignedClinicianName` to.
     * Only ever asked for a principal (see the calendar route), but the gate
     * is here rather than there so the field can never leak past it.
     */
    const assignedClinicianNameFor = (patientId: string): Promise<string | undefined> => {
      const cached = assignedClinicianNameCache.get(patientId);
      if (cached) {
        return cached;
      }
      const pending = (async () => {
        const record = await patientRecordFor(patientId);
        if (!record) {
          return undefined;
        }
        const profile = {
          entityType: PATIENT_PROFILE_ENTITY_TYPE,
          ownerPatientId: patientId,
          assignedClinicianId: record.assigned_clinician_id,
        } as const;
        if (!can(principal, 'read', profile).allowed) {
          return undefined;
        }
        return record.assigned_clinician_id
          ? clinicianNameFor(record.assigned_clinician_id)
          : undefined;
      })();
      assignedClinicianNameCache.set(patientId, pending);
      return pending;
    };

    /**
     * Both names attached, ready for `projectAllFor`.
     *
     * Enriched **before** projection, not after: `projectFor` is what brands
     * a value `Projected`, and building the enriched object first means the
     * brand is earned rather than re-applied by a cast to something the
     * boundary never saw. Generic over the record so this needs no
     * `Appointment` import and cannot silently accept a row without the two
     * ids it joins on.
     */
    const withNames = <T extends { readonly patientId: string; readonly clinicianId: string }>(
      appointments: readonly T[],
    ): Promise<(T & { patientName?: string; clinicianName?: string })[]> =>
      Promise.all(
        appointments.map(async (appointment) => {
          const [patientName, clinicianName] = await Promise.all([
            patientNameFor(appointment.patientId),
            clinicianNameFor(appointment.clinicianId),
          ]);
          return {
            ...appointment,
            ...(patientName ? { patientName } : {}),
            ...(clinicianName ? { clinicianName } : {}),
          };
        }),
      );

    /**
     * Every treating clinician's slice of a range, gathered into one list.
     *
     * Fanned out over the directory rather than scanned: `list()` is a single
     * GSI2 `Query` plus a `GetItem` per clinician, and only the *treating*
     * roles are queried at all — a helpdesk or visitor row can own no
     * appointment, so querying GSI1 for one would be a read that can only
     * ever return nothing.
     */
    const practiceCalendar = async (from: string, to: string) => {
      const directory = await deps.clinicians.list();
      const perClinician = await Promise.all(
        directory
          .filter((clinician) => TREATING_CLINICIAN_ROLES.includes(clinician.role))
          .map((clinician) => deps.appointments.listForClinicianCalendar(clinician.id, from, to)),
      );
      // Each clinician's own slice arrives chronological; their union is not,
      // and every consumer of this route treats `items` as one ordered list.
      // Sorted on the ISO instant, which orders correctly as a string at a
      // fixed offset — the same property the client's `groupByDay` relies on.
      return perClinician.flat().sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    };

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
      // ## 2026-09-06: for a helpdesk, "me" is the desk — not a caseload
      //
      // The owner: *"for help desk I want to show on the landing dashboard
      // both ready only calender and patient dashboard - the two stuff the
      // principal clinician is seeing but in read only mode."*
      //
      // A helpdesk account is a `CLI#` row and so *has* a `clinicianId`, but
      // no patient is ever assigned to one — `listForClinicianCalendar` on
      // their own id returns an empty calendar, today and forever. The
      // reading that is actually useful is also the one that matches what
      // they already get one section below on the same dashboard: the
      // **practice's** calendar. `caseload-repository.ts` hands a helpdesk
      // every patient rather than a filtered set, because `authz-matrix.ts`'s
      // Helpdesk column is role-alone with no relationship narrowing;
      // `Appointments` grants them the identical unnarrowed `R`. So this
      // discloses nothing the matrix did not already allow — it is the same
      // rows they may read one at a time, gathered into one answer.
      //
      // **This is not the parameter the plan forbids.** 05-execution-plan.md's
      // *"Do NOT: let the calendar query accept a clinicianId parameter a
      // caller supplies"* is about a caller *naming* whose calendar to read,
      // and nothing here is supplied: the expansion is derived from the
      // caller's own role. A sub-clinician asking for this route still gets
      // their own single calendar, byte for byte as before.
      //
      // `clinicianId` is guaranteed non-empty for both clinician roles by
      // `requirePrincipal`'s own schema — the `can()` check above already
      // depended on it being set for a sub-clinician, and a principal's
      // own `clinicianId` is always their own subject id regardless.
      const appointments =
        principal.role === 'helpdesk'
          ? await practiceCalendar(from, to)
          : await deps.appointments.listForClinicianCalendar(
              principal.clinicianId as string,
              from,
              to,
            );
      const named = await withNames(appointments);
      // **The principal and the helpdesk** also get, per row, the clinician
      // the patient is *assigned* to. The owner, first of the principal
      // (*"since it's a principal clinician show the clinician name this
      // patient has assigned to as well"*) and then of the helpdesk (*"for
      // help desk account … also show the name of the clinician this patient
      // is assigned to. just like principal clinician"*). Both read the
      // practice's whole calendar, so an appointment they see may be anyone's
      // patient — which is exactly the question this answers. A sub-clinician
      // is left out: they read only their own patients, so the field would
      // name themselves on every row. Enriched before projection like the
      // names above, and absent (never blank) where the assignment could not
      // be resolved or disclosed.
      const showsAssignedClinician =
        principal.role === 'principal-clinician' || principal.role === 'helpdesk';
      const enriched = showsAssignedClinician
        ? await Promise.all(
            named.map(async (appointment) => {
              const assignedClinicianName = await assignedClinicianNameFor(appointment.patientId);
              return assignedClinicianName ? { ...appointment, assignedClinicianName } : appointment;
            }),
          )
        : named;
      const items = projectAllFor(principal, enriched, resource);
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
        // Approval is the patient's *first* word about this slot, now that
        // the request itself is silent — and a decline stays silent for the
        // same reason. `decline` only ever acts on a `pending-approval` row
        // (`expect` enforces it inside the write), so the patient provably
        // never heard of it; "your appointment was cancelled" about
        // something they were never told they had is worse than saying
        // nothing, and would leak the existence of the request the gate
        // just rejected.
        if (!isApprove) {
          return respond(200, { item: projectFor(principal, decided, resource) });
        }
        const notified = await notify('appointment-approved', {
          subjectAt: decided.scheduledAt,
        });
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
      const items = projectAllFor(principal, await withNames(appointments), resource);
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
        // Read before the write purely to learn the status being left.
        // `cancel` transitions from any status and returns only the new
        // row, so the finished appointment cannot say whether the patient
        // ever knew it existed — and that is exactly the question here. A
        // clinician withdrawing a still-pending request must not send the
        // patient a cancellation for a slot the approval gate never let
        // them see; cancelling a confirmed one must still tell them,
        // because that one was real and they were relying on it.
        const before = await deps.appointments.get(patientId, apptId);
        const wasConfirmed = before?.appointment_status !== 'pending-approval';
        const cancelled = await deps.appointments.cancel(patientId, apptId, actor);
        if (!wasConfirmed) {
          return respond(200, { item: projectFor(principal, cancelled, resource) });
        }
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
      // **The patient's assigned clinician, not whoever booked it**
      // (2026-09-03). The owner: *"when I as a principal clinician approve
      // a booking … I see a join the call button. But the clinician who
      // has been assigned this patient doesnt see any join the call
      // button."*
      //
      // This line used to read `principal.clinicianId`, on a comment
      // asserting that "only the assigned sub-clinician ever reaches this
      // line". That stopped being true when the matrix gave the principal
      // `C R U J` on `Appointments` (the 2026-08-31 amendment: the
      // principal is a practising clinician, not an overseer), and nothing
      // here noticed.
      //
      // The consequence was not a permission error — it was worse, because
      // it looked like it worked. `clinicianId` is what `gsi1pk` keys the
      // clinician calendar on *and* what `ws-join.ts` checks `join-call`
      // against, so a principal-booked appointment attached itself to the
      // principal: it appeared on their calendar with a join link, and was
      // invisible and unjoinable to the clinician who was actually going
      // to treat the patient.
      //
      // An appointment is the patient's session with their treating
      // clinician. Who typed it in is administrative and is recorded in
      // the audit log, which is where that fact belongs. The fallback is
      // the booker, for the one case the assignment cannot answer: a
      // patient with no clinician yet, which only the principal can book
      // for at all.
      clinicianId: patient.assigned_clinician_id ?? (principal.clinicianId as string),
      scheduledAt: parsed.data.scheduledAt,
      durationMinutes: parsed.data.durationMinutes,
    };

    // **Every booking waits for approval, whoever made it.** 2026-09-02,
    // the owner: *"when I assign an appointment to a patient, it should be
    // visible to patient dashboard to be approved by principal clinician
    // before it appears to patient profile — atm it appears to patient
    // profile right away."*
    //
    // The first cut exempted the principal, on the reasoning that the
    // approver approving themselves is a step with no decision in it. That
    // was wrong about what the step is *for*. It is not the principal
    // proving something to themselves — it is the gate that decides when a
    // booking becomes real **to the patient**, and the owner wants to see
    // every appointment sitting in that queue before it reaches anyone's
    // profile. A booking made in error is caught by the same review
    // whoever typed it.
    //
    // So this is no longer read off the role at all, and there is
    // deliberately nothing left here to get wrong: one status for every
    // new booking, and one route out of it (`…/approve`).
    const REQUIRES_APPROVAL = true;

    try {
      const created = await deps.appointments.schedule(input, actor, {
        requiresApproval: REQUIRES_APPROVAL,
      });
      // **No notification. A request is not news to the patient.**
      // 2026-09-02, the owner: *"I dont want to see 'Your clinician has
      // requested an appointment. It is waiting to be confirmed.' … I only
      // want to see confirmed appointments."*
      //
      // The first cut announced the request the moment it was made, which
      // quietly undid the approval gate in the one place it counts.
      // `summariseCalendar` was already careful about this — a
      // `pending-approval` slot is deliberately never "your next
      // appointment", because there is nothing yet to turn up to — and then
      // the notification told them about it anyway. The gate is only real
      // if the patient hears nothing until it opens. `…/approve` is what
      // tells them, and it is now the only thing that does.
      return respond(201, { item: projectFor(principal, created, resource) });
    } catch (error) {
      if (error instanceof AppError && error.code === 'APPOINTMENT_ALREADY_EXISTS') {
        return respond(409, { error: error.code });
      }
      throw error;
    }
  };
}
