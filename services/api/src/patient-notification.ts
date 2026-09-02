// 2026-09-01: the patient's own dashboard feed — `GET
// /patients/me/notifications` and `POST
// /patients/me/notifications/{notificationId}/read`.
//
// **Two routes, one column.** `authz-matrix.ts`'s `Patient notifications`
// row grants `R U` to `Patient (own)` and nothing to anybody else, so
// these are the only two things anyone can do to this entity over HTTP.
// A clinician cannot read a patient's feed and cannot write to it; the
// rows are written as a side effect of an appointment action that was
// already authorised on its own row (see
// `patient-notification-repository.ts`).
//
// **`/me` is the only id this route accepts, and that is structural
// rather than checked.** Every other patient-scoped route in this codebase
// takes `{id}` and resolves `me` against the caller — which is right for
// them, because staff legitimately read a named patient's record. Nobody
// but the patient may read this one, so there is no parameter through
// which a different patient could be named in the first place: the path
// is literally `/patients/me/notifications`. `can()` is still asked — the
// matrix is the boundary, not the route shape — but a caller who is not a
// patient has nothing to point at even before it answers.
import type { PatientNotificationKind, Principal } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';

import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import type { PatientNotificationRepository } from './patient-notification-repository.js';
import { projectAllFor, projectFor, serialiseResponse, type ResponseBody } from './projection.js';
import { requirePrincipal } from './request-principal.js';

/** Shares the appointments flag: the whole feature exists to report calendar changes, and a feed with nothing able to write to it is not worth turning on separately. */
const NOTIFICATIONS_FLAG = 'appointments.enabled';

const PATIENT_NOTIFICATION_ENTITY = 'patient-notification';

const NOTIFICATION_LOG_SAMPLE_RATE = 1;

/**
 * Kinds that are no longer raised and must not be shown, including for
 * rows written before they were retired.
 *
 * `'appointment-requested'` stopped being written on 2026-09-02 (see
 * `appointment.ts`: a pending request is the exact thing the approval gate
 * exists to keep from being real to the patient). Suppressing it *here* as
 * well as at the source is what makes the change take effect for the feeds
 * that already have one sitting in them — the owner's own dashboard among
 * them — without deleting stored rows, which is a decision no bug fix
 * should be making on its own (D-03) and which the audit log would
 * disagree with anyway.
 */
const RETIRED_NOTIFICATION_KINDS: readonly PatientNotificationKind[] = ['appointment-requested'];

export interface PatientNotificationDeps {
  readonly notifications: PatientNotificationRepository;
  readonly flags: FlagReader;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createPatientNotificationHandler(
  deps: PatientNotificationDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: NOTIFICATION_LOG_SAMPLE_RATE });

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

    if (!(await deps.flags.isEnabled(NOTIFICATIONS_FLAG))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    let principal: Principal;
    try {
      principal = requirePrincipal(event);
    } catch {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    const isList = routeKey === 'GET /patients/me/notifications';
    const isMarkRead = routeKey === 'POST /patients/me/notifications/{notificationId}/read';
    if (!isList && !isMarkRead) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    // A clinician principal has no `patientId` at all, so `ownerPatientId`
    // below is `undefined` — which can never equal a patient's own
    // non-empty `patientId` in `resolveColumn`, landing every non-patient
    // caller outside the one column this row grants. The same "no
    // special-cased rejection needed" shape `GET /caseload/mine` relies on.
    const resource = {
      entityType: PATIENT_NOTIFICATION_ENTITY,
      ownerPatientId: principal.patientId,
    } as const;

    if (isList) {
      if (!can(principal, 'read', resource).allowed) {
        return respond(403, { error: 'FORBIDDEN' });
      }
      const items = await deps.notifications.listForPatient(principal.patientId as string);
      const shown = items.filter((item) => !RETIRED_NOTIFICATION_KINDS.includes(item.kind));
      return respond(200, { items: projectAllFor(principal, shown, resource) });
    }

    if (!can(principal, 'update', resource).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }
    const notificationId = event.pathParameters?.notificationId;
    if (!notificationId) {
      return respond(400, { error: 'ID_REQUIRED' });
    }
    const updated = await deps.notifications.markRead(
      principal.patientId as string,
      notificationId,
    );
    if (!updated) {
      return respond(404, { error: 'RECORD_NOT_FOUND' });
    }
    return respond(200, { item: projectFor(principal, updated, resource) });
  };
}
