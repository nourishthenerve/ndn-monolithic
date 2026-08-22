// TASK 2.1.3 step 7: `GET /audit?date=`, behind `can(principal, 'read',
// { entityType: 'audit' })` — which docs/plan/04-data-model-rbac.md's
// matrix grants to the principal clinician and to nobody else ("| Audit
// log | — | — | — | — | R |"). This file is SDK-free and unit-testable;
// audit-read-handler.ts is the only place the real DynamoDB-backed reader
// and the real principal source are wired, the same split
// content-read-handler.ts and testimonial-moderation-handler.ts use.
//
// The authorisation is one `can()` call and no role test of its own. That
// is the whole point of TASK 2.1.1's ordering — the spine went first so
// every handler after it asks the matrix rather than re-deriving a
// permission — and it is why the two negative tests this task owes ("GET
// /audit as a patient and as a sub-clinician → 403") are assertions about
// this file rather than about a policy restated inside it.
import type { Principal } from '@ndn/shared-types';
import type { APIGatewayProxyHandlerV2WithLambdaAuthorizer } from 'aws-lambda';

import type { AuditReader } from './audit.js';
import { can } from './authz.js';
import { systemClock, type Clock } from './clock.js';
import { AUDIT_DATE_PATTERN } from './dynamo-audit-log.js';
import type { FlagReader } from './flags.js';
import { createSampledLogger, type RequestLogger } from './logger.js';
import { projectAllFor, serialiseResponse, type ResponseBody } from './projection.js';

// Every request, unsampled: this is the lowest-volume endpoint in the
// estate (one principal clinician, on demand) and the one whose own access
// a reviewer is most likely to want to reconstruct later.
const AUDIT_READ_LOG_SAMPLE_RATE = 1;

/** The matrix row this endpoint is governed by — `ENTITY_TYPE_ROWS.audit`, 'Audit log'. */
const AUDIT_RESOURCE = { entityType: 'audit' } as const;

export interface AuditReadDeps {
  readonly reader: AuditReader;
  readonly flags: FlagReader;
  /**
   * Resolves the caller. Undefined means "no identity on this request" —
   * a 401, distinct from a resolved principal the matrix then denies (403).
   * TASK 2.5.4: audit-read-handler.ts wires this to the real Lambda
   * authorizer's context (2.2.2) via `optionalPrincipal`.
   */
  readonly resolvePrincipal: (
    event: Parameters<APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined>>[0],
  ) => Promise<Principal | undefined>;
  readonly clock?: Clock;
  readonly logger?: RequestLogger;
}

export function createAuditReadHandler(
  deps: AuditReadDeps,
): APIGatewayProxyHandlerV2WithLambdaAuthorizer<Record<string, unknown> | undefined> {
  const clock = deps.clock ?? systemClock;
  const logger =
    deps.logger ?? createSampledLogger({ clock, sampleRate: AUDIT_READ_LOG_SAMPLE_RATE });

  return async (event) => {
    const start = clock.now();

    const respond = (statusCode: number, body: ResponseBody) => {
      logger.logRequest({
        requestId: event.requestContext.requestId,
        route: '/audit',
        statusCode,
        durationMs: clock.now().getTime() - start.getTime(),
      });
      return {
        statusCode,
        headers: { 'content-type': 'application/json' },
        body: serialiseResponse(body),
      };
    };

    // Flag: audit.readApi.enabled — default off, and off means "this route
    // does not exist" rather than "you may not have it", same as every
    // other flag-gated endpoint. The *writer* is deliberately not flagged:
    // an audit log that can be switched off is not an audit log.
    if (!(await deps.flags.isEnabled('audit.readApi.enabled'))) {
      return respond(404, { error: 'NOT_FOUND' });
    }

    const principal = await deps.resolvePrincipal(event);
    if (!principal) {
      return respond(401, { error: 'UNAUTHORIZED' });
    }

    // Checked before the date is even parsed: a caller the matrix denies
    // must not be able to tell a well-formed date from a malformed one by
    // the shape of the refusal.
    if (!can(principal, 'read', AUDIT_RESOURCE).allowed) {
      return respond(403, { error: 'FORBIDDEN' });
    }

    const date = event.queryStringParameters?.date;
    if (!date) {
      return respond(400, { error: 'DATE_REQUIRED' });
    }
    if (!AUDIT_DATE_PATTERN.test(date)) {
      return respond(400, { error: 'INVALID_DATE' });
    }

    const events = await deps.reader.listByDate(date);
    // An audit row carries identifiers only and has no `private{}` half by
    // construction (step 5), so this projection strips nothing today. It
    // is here because docs/runbooks/private-field-boundary.md's convention
    // is that every Phase 2+ endpoint leaves through `serialiseResponse`,
    // and `serialiseResponse` accepts a projected value and nothing else —
    // the day a row does carry one, this endpoint is already closed.
    return respond(200, { items: projectAllFor(principal, events, AUDIT_RESOURCE) });
  };
}
