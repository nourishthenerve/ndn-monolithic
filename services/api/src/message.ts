// TASK 3.6.1: patient↔clinician messaging, and the matrix correction that
// makes it genuinely bidirectional. `04-data-model-rbac.md`'s Messages row
// stood as `'Patient (own)': C R (own thread)` but
// `'Sub-clinician (assigned)': R (own patients)` — read-only — which does
// not match the row's own key-shape description, "Patient↔clinician."
// Corrected in the doc first, then transcribed into `authz-matrix.ts`, per
// that file's own standing rule — the identical order TASK 2.5.1 followed
// for "Patient assignment."
//
// A real finding in this task's own prose, despite this task's own title
// being "the matrix corrected": step 2 says `POST /patients/{id}/messages`
// is now open to "the owning patient or an assigned sub-clinician or the
// principal." The correction above only ever touched the
// `'Sub-clinician (assigned)'` cell — `authz-matrix.ts`'s `Principal` cell
// on this row is, and remains, bare `R`. A principal reads any thread
// (the cross-caseload oversight every other row in this phase already
// grants them) but never sends — the fourth instance this phase of the
// same class of plan-prose mistake (assessment forms, appointments,
// content assignment), always caught by a test against the matrix rather
// than the task's own description.
//
// Two routes: `POST /patients/{id}/messages` (send), `GET
// /patients/{id}/messages?cursor=` (the thread, chronological, paginated).
//
// D-32 (2026-08-30): step 5's own notification side-effect ("you have a
// new message") is deleted, not darkened — the owner's own words, "any
// notification will go via whatsapp." Sending and reading a message are
// entirely unchanged; only the "then tell the other party by email" step
// is gone. See docs/runbooks/messaging.md.
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
import { MESSAGE_ENTITY_TYPE, type MessageRepository } from './message-repository.js';
import type { PatientRepository } from './patient-repository.js';
import { projectAllFor, projectFor, serialiseResponse, type ResponseBody } from './projection.js';
import type { RateLimiter } from './rate-limiter.js';
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

const MESSAGING_FLAG = 'messaging.enabled';

const sendBodySchema = z.object({ body: z.string().min(1) }).strict();

// C-11's own arithmetic doesn't apply here — messaging carries no per-send
// AWS cost the way SMS does, and no anti-bot posture the way the public
// contact form does. This is a real, back-and-forth conversational
// channel between two already-authenticated parties: the limit exists to
// bound a scripted flood, not a normal exchange, so it is deliberately
// far more generous than SMS's 5/hour or the contact form's 3/hour — both
// of which are tight by design for a different reason (real send cost,
// anonymous callers). 30/hour is roughly one message every two minutes
// sustained for a full hour, well above any normal conversational pace.
export const MESSAGE_RATE_LIMIT_PER_PRINCIPAL = 30;
export const MESSAGE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export interface MessageDeps {
  /** For the assignment-relationship lookup `can()` needs. */
  readonly patients: PatientRepository;
  readonly messages: MessageRepository;
  readonly flags: FlagReader;
  readonly rateLimiter: RateLimiter;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

const MESSAGE_LOG_SAMPLE_RATE = 1;

export function createMessageHandler(
  deps: MessageDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger = deps.logger ?? createSampledLogger({ clock, sampleRate: MESSAGE_LOG_SAMPLE_RATE });

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

    if (!(await deps.flags.isEnabled(MESSAGING_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const isSend = routeKey === 'POST /patients/{id}/messages';
    const isList = routeKey === 'GET /patients/{id}/messages';
    if (!isSend && !isList) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const rawId = event.pathParameters?.id;
    if (!rawId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }
    // `/patients/me/messages` — the identical `/me` resolution
    // `patient.ts`/`clinical-record.ts`/`appointment.ts`/
    // `content-assignment.ts` already give their own patient routes.
    const patientId =
      rawId === 'me' && principal.role === 'patient' ? (principal.patientId ?? rawId) : rawId;

    // Fetched before `can()`, the same reason every other patient-scoped
    // handler in this codebase does: the sub-clinician column depends on
    // `assigned_clinician_id`, which only the patient record can answer.
    const patient = await deps.patients.findById(patientId);
    const resource = {
      entityType: MESSAGE_ENTITY_TYPE,
      ownerPatientId: patientId,
      assignedClinicianId: patient?.assigned_clinician_id,
    } as const;
    const actor = actorFromPrincipal(principal, requestOriginOf(event));

    if (isList) {
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      if (!patient) {
        return respond(404, { error: 'RECORD_NOT_FOUND' });
      }
      const cursor = event.queryStringParameters?.cursor;
      const page = await deps.messages.listForThread(patientId, cursor);
      const items = projectAllFor(principal, page.items, resource);
      return respond(200, { items, nextCursor: page.nextCursor });
    }

    if (!can(principal, 'create', resource).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }
    // Unlike appointments/assessments/content-assignment, this branch is
    // NOT unreachable by construction for the `'Patient (own)'` column —
    // this row's own patient cell carries `create` too (the finding
    // above's whole point: messaging is genuinely bidirectional). It
    // remains unreachable for `'Sub-clinician (assigned)'`, the identical
    // reasoning every other entity's own defence-in-depth branch states.
    // Kept as one check either way: a signed-in patient whose own `PAT#`
    // record somehow doesn't resolve is an operational invariant this
    // handler still refuses safely, not a case this codebase's
    // registration flow is expected to produce.
    if (!patient) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }

    const parsed = sendBodySchema.safeParse(parseJsonBody(event));
    if (!parsed.success) {
      return respond(400, { error: 'INVALID_BODY' });
    }

    const withinRate = await deps.rateLimiter.tryConsume(principal.subjectId);
    if (!withinRate) {
      return respond(429, { error: 'RATE_LIMITED' });
    }

    const sent = await deps.messages.send(
      { patientId, senderRole: principal.role, body: parsed.data.body },
      actor,
    );
    return respond(201, { item: projectFor(principal, sent, resource) });
  };
}
