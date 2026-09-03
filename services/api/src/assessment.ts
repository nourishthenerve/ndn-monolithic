// TASK 3.3.1/3.3.2: assessment forms — the entity `authz-matrix.ts` has
// carried dedicated matrix rows for since TASK 2.1.1, and `authz.test.ts`'s
// exhaustive suite has asserted every cell of every one of them since the
// same task, including the row R-09's own register entry names directly:
// "a patient reaches no private assessment field, in any relationship."
//
// ## 2026-09-01 — four sections, four sets of writers
//
// The owner's form has four sections and four different answers to "who
// may edit this". The handler's whole shape follows from one consequence
// of that, which is worth stating before the code rather than leaving to
// be inferred:
//
// **A caller never sends a whole record, and never receives one either.**
//
//   * On the way *out*, the response is built by **omission**: a section
//     the caller may not read is not fetched into the response object and
//     then filtered — the object is constructed with only the keys `can()`
//     allowed, so there is no moment at which a denied section is present
//     in something that could be logged, thrown, or serialised by mistake.
//     This is the same construction TASK 3.3.2 already chose for
//     `private{}` alone, now applied per section. Every object still goes
//     through `projectFor` before `respond()`, which for the readable
//     shapes is a provable no-op — it costs nothing and keeps the "every
//     response goes through `projectFor`" discipline whole rather than
//     carving out an exception on this one route.
//   * On the way *in*, the request is a **section-scoped patch**, and the
//     unnamed sections are carried forward server-side
//     (`AssessmentRepository.applySectionPatch`). A patient editing their
//     general info therefore never has to send back — or even possess —
//     the clinician's section. The alternative shape, "POST the new
//     version you want", cannot be made safe for a four-writer record: it
//     forces every writer to round-trip content they cannot read.
//
// `can()` is asked **once per section named**, never once with a
// fabricated "give me everything" resource, and the request is atomic: if
// any named section is denied the whole write is a 403, so a patch is
// never half-applied.
//
// ## The two narrowings that are not in the matrix
//
// Both are named in docs/plan/04-data-model-rbac.md and enforced here,
// because the matrix has no vocabulary for either:
//
//   * **A visitor sees IIC-tagged patients only.** `can()` answers "may a
//     visitor read a general section at all"; only the patient record
//     answers "is this one theirs to see". The check is here as well as in
//     `caseload-repository.ts` because they are two different reads — a
//     visitor stopped only at the list would still reach a record by
//     guessing an id. A non-matching patient gets the same `404` a
//     nonexistent one does: a `403` would confirm the patient exists.
//   * **A patient may not write the `tag` field** even though they may
//     write the section it lives in. The tag is the entire mechanism
//     bounding a visitor's reach, so the subject of the record must not
//     choose it. Marked `staffOnly` on the template so the form and the
//     API read the rule from one declaration.
//
// ## The calendar section is derived, not stored
//
// "When is the next appointment", "how many sessions so far" and "how many
// are awaiting approval" are facts about `APPT#` rows, computed here on
// every read and returned as a separate `calendarSummary` — never merged
// into a version's stored responses. Two copies would be two answers the
// first time a write half-succeeded, and the `APPT#` rows are already what
// the approval workflow, the clinician calendar and the join-call window
// read. Keeping the summary out of `items[]` also means the form has
// nothing derived to accidentally POST back.
import type {
  Appointment,
  AssessmentFieldDef,
  AssessmentSectionDef,
  AssessmentValue,
  FieldSet,
  Patient,
  PatientTag,
  Principal,
} from '@ndn/shared-types';
import {
  ASSESSMENT_SECTION_ORDER,
  ASSESSMENT_TAG_FIELD_ID,
  ASSESSMENT_TAG_OPTIONS,
  countsTowardTotal,
  isAppointmentOver,
  templateField,
  templateSection,
} from '@ndn/shared-types';
import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyHandlerV2WithLambdaAuthorizer,
} from 'aws-lambda';
import { z } from 'zod';

import type { AppointmentRepository } from './appointment-repository.js';
import { isAttachmentKeyInSection } from './assessment-attachments.js';
import type {
  AssessmentPatch,
  AssessmentSectionPatch,
  AssessmentRepository,
} from './assessment-repository.js';
import { actorFromPrincipal, requestOriginOf } from './audit.js';
import { ASSESSMENT_ENTITY_TYPE } from './authz-matrix.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import { AppError } from './errors.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { PatientNotificationRepository } from './patient-notification-repository.js';
import type { PatientRepository } from './patient-repository.js';
import { projectFor, serialiseResponse, type ResponseBody } from './projection.js';
import { requirePrincipal } from './request-principal.js';

const ASSESSMENTS_FLAG = 'assessments.enabled';

/** The tag a `visitor` account is entitled to see. A constant, not a parameter — the same security property `caseload-repository.ts`'s own copy states: there is nowhere in the request to ask for another programme's patients. */
const VISITOR_TAG: PatientTag = 'IIC';

const attachmentSchema = z
  .object({
    key: z.string().min(1).max(1024),
    fileName: z.string().min(1).max(200),
    contentType: z.string().min(1).max(200),
  })
  .strict();

/**
 * `responses` is a merge, `addAttachments` is an append — see
 * `AssessmentSectionPatch`'s own doc for why a caller can never send an
 * attachment *list*.
 */
const sectionPatchSchema = z
  .object({
    responses: z.record(z.string().max(100), z.union([z.string().max(20000), z.number(), z.boolean()])).optional(),
    addAttachments: z.array(attachmentSchema).max(20).optional(),
  })
  .strict();

const patchBodySchema = z
  .object({
    /**
     * The version the caller read and is editing; the server writes
     * `baseVersion + 1`. `0` means "I saw no form at all", which is the
     * only value that may instantiate one. Two writers who both read
     * version 3 both try to write 4, and the second gets a 409 rather
     * than silently discarding the first one's section — the optimistic
     * concurrency this entity needs now that four roles write it.
     */
    baseVersion: z.number().int().min(0),
    sections: z
      .object({
        general: sectionPatchSchema.optional(),
        patient: sectionPatchSchema.optional(),
        private: sectionPatchSchema.optional(),
        calendar: sectionPatchSchema.optional(),
      })
      .strict()
      .refine((sections) => Object.keys(sections).length > 0, {
        message: 'at least one section must be named',
      }),
  })
  .strict();

export interface AssessmentDeps {
  /** For the assignment-relationship lookup `can()` needs, the visitor tag gate, and the tag write-through — never for an assessment read or write, which stays on `assessments` below. */
  readonly patients: PatientRepository;
  readonly assessments: AssessmentRepository;
  /** Read-only here: the calendar section's figures are derived from these rows and never written through this handler. Booking stays on the `Appointments` row and its own endpoints. */
  readonly appointments: AppointmentRepository;
  /**
   * "When a clinician/principal clinician edits a calender for a given
   * patient it will appear as a notification on patients logged in
   * dashboard." A calendar-section write is one of the two things that
   * sentence covers — the other is booking, which
   * `appointment.ts` notifies for.
   */
  readonly notifications: PatientNotificationRepository;
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

/** The figures the calendar section shows, all of them counted off `APPT#` rows. */
interface CalendarSummary {
  readonly nextAppointmentAt?: string;
  readonly nextAppointmentDurationMinutes?: number;
  /** Every appointment that stands — see `COUNTED_APPOINTMENT_STATUSES`. */
  readonly totalAppointments: number;
  /** Only the ones that actually happened. Narrower than `totalAppointments`, and deliberately a separate figure. */
  readonly sessionsCompleted: number;
  readonly appointmentsAwaitingApproval: number;
}

/**
 * **The whole of a visitor's calendar reach**, 2026-09-01: the owner, asked
 * whether a visitor should keep the count-only view or gain the calendar —
 * *"i want visitor read only both total number of appointments and next
 * appointment."*
 *
 * Read as an enumeration, not an example, which makes this a narrowing of
 * what the first cut gave them and closes a leak it had opened. A visitor
 * could read the calendar section's *stored* content, and the only stored
 * field in it is `schedulingNotes` — clinician-authored free text about a
 * patient, reaching a partner organisation's account. Nothing asked for
 * that; it arrived because "may read the calendar section" was implemented
 * as "may read everything in it".
 *
 * So a visitor's calendar is **derived figures only, and only these two**:
 * no stored responses, no attachments, no `sessionsCompleted`, and no
 * `appointmentsAwaitingApproval` (the practice's own workflow, and a number
 * that would move as the principal worked a queue).
 *
 * This is the third place a visitor is narrowed by something other than a
 * matrix cell — `caseload-repository.ts`'s tag filter and field omission
 * being the first two — and the reason is the same each time: the matrix
 * says which rows, never which fields of a row.
 */
const VISITOR_CALENDAR_FIELDS: readonly string[] = [
  'totalAppointments',
  'nextAppointmentAt',
  'nextAppointmentDurationMinutes',
];

/** A visitor's summary, built by omission — the fields simply never leave this function. */
function visitorCalendarSummary(summary: CalendarSummary): Record<string, string | number> {
  const narrowed: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (VISITOR_CALENDAR_FIELDS.includes(key) && value !== undefined) {
      narrowed[key] = value as string | number;
    }
  }
  return narrowed;
}

/**
 * "Next" is the earliest **confirmed** appointment that has not yet
 * finished — a `pending-approval` slot is deliberately not one, because
 * until the principal has approved it there is nothing for the patient to
 * turn up to, and showing it as their next appointment would be telling
 * them something that is not yet true. It is surfaced as its own count
 * instead, which is what the principal's approval queue reads.
 *
 * **2026-09-03: "not yet finished", not "still in the future".** This read
 * `scheduledAt <= nowIso` and so retired an appointment the moment it
 * *began* — the one moment it is actually happening. See
 * `isAppointmentOver`'s own note for the four places that made the same
 * mistake and what it cost.
 */
export function summariseCalendar(
  appointments: readonly Appointment[],
  now: Date,
): CalendarSummary {
  let next: Appointment | undefined;
  let totalAppointments = 0;
  let sessionsCompleted = 0;
  let appointmentsAwaitingApproval = 0;
  for (const appointment of appointments) {
    // Counted first and independently of everything below: "how many
    // appointments" is a different question from "which is next" and from
    // "how many happened", and each `continue` in the branches that follow
    // would otherwise silently exclude a row from this total too.
    if (countsTowardTotal(appointment.appointment_status)) {
      totalAppointments += 1;
    }
    if (appointment.appointment_status === 'completed') {
      sessionsCompleted += 1;
      continue;
    }
    if (appointment.appointment_status === 'pending-approval') {
      appointmentsAwaitingApproval += 1;
      continue;
    }
    if (
      appointment.appointment_status !== 'scheduled' ||
      isAppointmentOver(appointment.scheduledAt, appointment.durationMinutes, now)
    ) {
      continue;
    }
    // ISO-8601 UTC strings compare correctly as strings (00-conventions.md
    // — every timestamp is stored that way, with a trailing `Z`), which is
    // also what makes the sort-key ordering these rows arrive in
    // meaningful. Still no Date parsing *here*: the "has it finished" test
    // above needs the duration and so has to leave string space, but
    // picking the earliest of two candidates does not.
    if (!next || appointment.scheduledAt < next.scheduledAt) {
      next = appointment;
    }
  }
  return {
    ...(next
      ? {
          nextAppointmentAt: next.scheduledAt,
          nextAppointmentDurationMinutes: next.durationMinutes,
        }
      : {}),
    totalAppointments,
    sessionsCompleted,
    appointmentsAwaitingApproval,
  };
}

/** Why a section patch was refused. `forbidden` is a 403; every other value is a 400. */
type SectionValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly forbidden: true }
  | { readonly ok: false; readonly forbidden?: false; readonly error: string };

const INVALID = (error: string): SectionValidation => ({ ok: false, error });

/**
 * A patch's `responses` against the template. The template is the schema:
 * a field it does not define cannot be written (which is what keeps this
 * from becoming an arbitrary key/value store on a clinical record), a
 * derived field cannot be written at all, and a `staffOnly` field cannot
 * be written by the patient.
 *
 * Reading is deliberately *not* symmetric — a stored answer to a field the
 * template no longer defines is returned as it is, because a record is
 * history and a template is the current form. Only writes are constrained.
 */
function validateResponses(
  fieldSet: FieldSet,
  responses: Readonly<Record<string, AssessmentValue>>,
  isPatient: boolean,
): SectionValidation {
  for (const [id, value] of Object.entries(responses)) {
    const field = templateField(fieldSet, id);
    if (!field) {
      return INVALID('UNKNOWN_FIELD');
    }
    if (field.derived) {
      return INVALID('DERIVED_FIELD_NOT_WRITABLE');
    }
    if (field.staffOnly && isPatient) {
      return { ok: false, forbidden: true };
    }
    if (field.type === 'number' && typeof value !== 'number') {
      return INVALID('INVALID_FIELD_TYPE');
    }
    if (field.type === 'checkbox' && typeof value !== 'boolean') {
      return INVALID('INVALID_FIELD_TYPE');
    }
    if (field.type !== 'number' && field.type !== 'checkbox' && typeof value !== 'string') {
      return INVALID('INVALID_FIELD_TYPE');
    }
    if (field.type === 'select' && !(field.options ?? []).includes(value as string)) {
      return INVALID('INVALID_FIELD_OPTION');
    }
  }
  return { ok: true };
}

/** Every attachment key must be one this patient/form/section could have produced — see assessment-attachments.ts on why the upload check alone is not enough. */
function validateAttachments(
  patch: AssessmentSectionPatch,
  patientId: string,
  assessmentId: string,
  fieldSet: FieldSet,
): SectionValidation {
  for (const attachment of patch.addAttachments ?? []) {
    if (!isAttachmentKeyInSection(attachment.key, patientId, assessmentId, fieldSet)) {
      return INVALID('ATTACHMENT_KEY_OUT_OF_SECTION');
    }
  }
  return { ok: true };
}

/**
 * The template a caller may actually see: sections they can read, and
 * nothing about the ones they cannot — not even a field label, which is
 * why this filters the template rather than letting the form hide things.
 *
 * A visitor's calendar section is cut down further, to the two figures
 * `VISITOR_CALENDAR_FIELDS` names. Without that the form would render
 * labels for a scheduling note and a session count they are never sent,
 * which reads as an empty record rather than as an absent permission.
 */
function readableTemplate(
  readable: ReadonlySet<FieldSet>,
  isVisitor: boolean,
): readonly AssessmentSectionDef[] {
  return ASSESSMENT_SECTION_ORDER.map((fieldSet) => templateSection(fieldSet))
    .filter(
      (section): section is AssessmentSectionDef =>
        section !== undefined && readable.has(section.fieldSet),
    )
    .map((section) =>
      isVisitor && section.fieldSet === 'calendar'
        ? {
            ...section,
            fields: section.fields.filter((field: AssessmentFieldDef) =>
              VISITOR_CALENDAR_FIELDS.includes(field.id),
            ),
          }
        : section,
    );
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

    const rawId = event.pathParameters?.id;
    const assessmentId = event.pathParameters?.assessmentId;
    if (!rawId || !assessmentId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }
    // `/patients/me/assessments/…` — the identical `/me` resolution
    // `patient.ts`/`appointment.ts` already give their own patient routes,
    // needed for the identical reason: a patient's own form page has no
    // other way to learn its own id.
    const patientId =
      rawId === 'me' && principal.role === 'patient' ? (principal.patientId ?? rawId) : rawId;

    // Fetched before `can()`, the same reason every other patient-scoped
    // handler in this codebase does: the sub-clinician column depends on
    // `assigned_clinician_id`, which only the patient record can answer.
    const patient: Patient | undefined = await deps.patients.findById(patientId);
    const resourceFor = (fieldSet: FieldSet) =>
      ({
        entityType: ASSESSMENT_ENTITY_TYPE,
        ownerPatientId: patientId,
        assignedClinicianId: patient?.assigned_clinician_id,
        fieldSet,
      }) as const;

    const readable = new Set<FieldSet>(
      ASSESSMENT_SECTION_ORDER.filter(
        (fieldSet) => can(principal, 'read', resourceFor(fieldSet)).allowed,
      ),
    );
    const writable = new Set<FieldSet>(
      ASSESSMENT_SECTION_ORDER.filter(
        (fieldSet) => can(principal, 'update', resourceFor(fieldSet)).allowed,
      ),
    );

    // Not a single section, in either direction — there is nothing on this
    // route for this caller at all. Checked before the record is fetched
    // so an unrelated caller learns nothing from timing either.
    if (readable.size === 0 && writable.size === 0) {
      return respond(403, { error: 'FORBIDDEN' });
    }

    if (!patient) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    const isVisitor = principal.role === 'visitor';

    // The visitor's second narrowing — see this file's header. `404`, not
    // `403`: a visitor must not be able to infer that a patient outside
    // their programme exists, and this is the same answer a genuinely
    // absent record gives. An untagged record (written before tagging
    // existed) is not `IIC`; absence is never read as membership.
    if (isVisitor && patient.tag !== VISITOR_TAG) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    if (isGet) {
      const versions = await deps.assessments.listVersions(patientId, assessmentId);
      const items = versions
        .slice()
        .reverse()
        .map((version) => {
          // Built by omission: only the readable sections are ever put on
          // this object, so a denied one is not present to be stripped,
          // logged or thrown. `projectFor` on the way out is defence in
          // depth over `private{}` specifically, not the boundary itself.
          const shape: Record<string, unknown> = {
            version: version.version,
            created_at: version.created_at,
            updated_at: version.updated_at,
          };
          for (const fieldSet of ASSESSMENT_SECTION_ORDER) {
            const section = version[fieldSet];
            // A visitor's calendar reach is the derived figures and
            // nothing else — see `VISITOR_CALENDAR_FIELDS`. The stored
            // half of that section is a clinician's scheduling note, and
            // it is omitted here rather than filtered downstream: the key
            // is never on the object a visitor is sent.
            if (isVisitor && fieldSet === 'calendar') {
              continue;
            }
            if (readable.has(fieldSet) && section !== undefined) {
              shape[fieldSet] = section;
            }
          }
          return projectFor(principal, shape, resourceFor('private'));
        });

      const permissions = ASSESSMENT_SECTION_ORDER.map((fieldSet) =>
        projectFor(
          principal,
          { fieldSet, read: readable.has(fieldSet), write: writable.has(fieldSet) },
          resourceFor(fieldSet),
        ),
      );

      const summary = readable.has('calendar')
        ? summariseCalendar(await deps.appointments.listForPatient(patientId), clock.now())
        : undefined;
      const shownSummary = summary && isVisitor ? visitorCalendarSummary(summary) : summary;

      return respond(200, {
        assessmentId,
        // `0` means "no form has ever been written for this patient" —
        // the value a caller sends back as `baseVersion` to instantiate
        // one. `items` being empty says the same thing; this says it in
        // the field the write actually reads.
        currentVersion: versions.at(-1)?.version ?? 0,
        template: readableTemplate(readable, isVisitor).map((section) =>
          projectFor(principal, section, resourceFor(section.fieldSet)),
        ),
        permissions,
        ...(shownSummary
          ? { calendarSummary: projectFor(principal, shownSummary, resourceFor('calendar')) }
          : {}),
        items,
      });
    }

    const parsed = patchBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY' });
    }
    // `.filter` on the value, not only the cast: a key present with an
    // explicit `undefined` would otherwise be "named" — authorised,
    // validated, and then applied as an empty patch — which is a strange
    // enough request to refuse to interpret.
    const named = (Object.entries(parsed.data.sections) as [FieldSet, AssessmentSectionPatch | undefined][])
      .filter((entry): entry is [FieldSet, AssessmentSectionPatch] => entry[1] !== undefined);
    if (named.length === 0) {
      return respond(400, { error: 'INVALID_BODY' });
    }
    const isPatient = principal.role === 'patient';

    // Validation before authorisation would leak the template's shape to a
    // caller with no business reading the section, so every section is
    // authorised first and the whole request is refused if any one is
    // denied — a patch is never half-applied.
    for (const [fieldSet] of named) {
      if (!writable.has(fieldSet)) {
        return respond(403, { error: 'FORBIDDEN' });
      }
    }

    for (const [fieldSet, patch] of named) {
      const responses = validateResponses(fieldSet, patch.responses ?? {}, isPatient);
      if (!responses.ok) {
        return responses.forbidden
          ? respond(403, { error: 'FORBIDDEN_FIELD' })
          : respond(400, { error: responses.error });
      }
      const attachments = validateAttachments(patch, patientId, assessmentId, fieldSet);
      if (!attachments.ok) {
        return respond(400, { error: attachments.forbidden ? 'FORBIDDEN_FIELD' : attachments.error });
      }
    }

    let latest = await deps.assessments.latest(patientId, assessmentId);
    if (!latest) {
      // `baseVersion: 0` is the caller saying "I saw no form". Anything
      // else means their view of this record is stale, or invented.
      if (parsed.data.baseVersion !== 0) {
        return respond(409, { error: 'VERSION_CONFLICT' });
      }
      // Lazily instantiated for a patient created before the form existed
      // — `POST /patients` instantiates for every account created since.
      // Idempotent, so a retried invocation cannot produce two version 1s,
      // and it happens on a write path only: a `GET` never writes.
      latest = await deps.assessments.instantiate(patientId, assessmentId, actor, {
        ...(patient.tag ? { tag: patient.tag } : {}),
      });
    } else if (parsed.data.baseVersion !== latest.version) {
      return respond(409, { error: 'VERSION_CONFLICT' });
    }

    // `create` for a section this record does not yet have (only
    // `private{}` can be in that state — see `AssessmentRepository`), and
    // `update` for one it does. That is what gives the matrix's `C` on
    // these rows a meaning distinct from `U`: adding the clinician's
    // section to a form that never had one.
    for (const [fieldSet] of named) {
      if (latest[fieldSet] === undefined && !can(principal, 'create', resourceFor(fieldSet)).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
    }

    // The tag's value is checked before anything is written; the
    // write-through itself happens *after* the version lands, below.
    const nextTag = parsed.data.sections.general?.responses?.[ASSESSMENT_TAG_FIELD_ID];
    const tagChange =
      typeof nextTag === 'string' && nextTag !== patient.tag ? nextTag : undefined;
    if (tagChange !== undefined && !ASSESSMENT_TAG_OPTIONS.includes(tagChange as PatientTag)) {
      return respond(400, { error: 'INVALID_FIELD_OPTION' });
    }

    try {
      const created = await deps.assessments.applySectionPatch(
        latest,
        latest.version + 1,
        actor,
        parsed.data.sections as AssessmentPatch,
      );
      // **The tag write-through, and it is deliberately after the version,
      // not before it.** `Patient.tag` is the authority — it is what
      // `caseload-repository.ts` and this handler's own visitor gate read
      // — and the general section's copy is what the form shows, so the
      // two can be out of step if exactly one of these two writes lands.
      // Which one goes first therefore decides which way a half-failure
      // errs, and the two directions are not equally bad:
      //
      //   * record first: a failed version write leaves `Patient.tag` at
      //     `IIC` with no form saying so — a visitor account can now read
      //     a patient nothing recorded a decision about. Over-permissive.
      //   * version first (this order): a failed record write leaves the
      //     form saying `IIC` while the record still says `NDN` — the
      //     visitor still sees nothing, and re-saving fixes it.
      //     Under-permissive, and visible to whoever is looking at the
      //     form.
      //
      // A 409 from the version write is the realistic case (two staff
      // editing at once), and it is the one that must not widen anyone's
      // reach. So the tag moves only once the version it is recorded on
      // actually exists.
      if (tagChange !== undefined) {
        await deps.patients.update(patientId, actor, { tag: tagChange as PatientTag });
      }

      // "When a clinician/principal clinician edits a calender for a given
      // patient it will appear as a notification on patients logged in
      // dashboard." Only the calendar section triggers one — editing the
      // general or clinician sections is not a calendar change, and a
      // dashboard that lit up for every field a clinician typed would stop
      // being read. Notified only when someone *other than the patient*
      // wrote it, so a patient is never told about their own edit.
      //
      // Not fatal, and not silent, for the same reasons the appointment
      // routes give: the version is already written by this line, and the
      // caller is told the outcome rather than left to infer it.
      let notified: boolean | undefined;
      if (parsed.data.sections.calendar && !isPatient) {
        notified = await deps.notifications
          .notify(patientId, 'calendar-updated', actor)
          .then(() => true)
          .catch(() => false);
      }
      // The response is the caller's own view of what they just wrote,
      // built by the same omission the `GET` uses — a helpdesk account
      // writing the general section does not get the clinician's section
      // back merely because the write succeeded.
      const shape: Record<string, unknown> = { version: created.version };
      for (const fieldSet of ASSESSMENT_SECTION_ORDER) {
        const section = created[fieldSet];
        if (readable.has(fieldSet) && section !== undefined) {
          shape[fieldSet] = section;
        }
      }
      return respond(201, {
        item: projectFor(principal, shape, resourceFor('private')),
        ...(notified === undefined ? {} : { notified }),
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'VERSION_ALREADY_EXISTS') {
        // Two writers who read the same version and both computed the same
        // next one. The loser is told to re-read, not silently merged.
        return respond(409, { error: 'VERSION_CONFLICT' });
      }
      throw error;
    }
  };
}
